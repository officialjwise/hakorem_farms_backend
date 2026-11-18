# B09b continued 1c: held sales, and a mobile money or card tender only as a payment the provider cleared

Date: 2026-11-17 · Branch `b09b2c-pos-held-provider-tender`, from `main` (`e526e1e`), rebased in the merge slot on `main` at `39c6198` (lane B's B09u: migrations 0247 to 0249 and contract 2.9.0, so this phase's migrations are renumbered 0250 and 0251 and its contract is 2.10.0) · Lane A · Status: **gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-276 (a) | A held sale reserves nothing (FR-POS-007's reserving setting is not built), so it has nothing to release; the counter sale re-checks stock when the recalled sale completes. | Owner |
| A-276 (b) | A hold lapses at the shift's declaration (`closeShift`) and at its force close, each lapse audited; the database refuses a shift leaving OPEN with a sale still held. | Owner |
| A-276 (c) | A hold lives at most twelve hours (`expiresAt`) if its shift runs that long. | Owner |
| A-276 (d) | Only the cashier of the till's open shift holds and recalls, on that shift, from a device of the till; a manager neither holds nor recalls (nobody sells on another cashier's shift, ADR-0077). Anyone who sells at the location may list the holds. | Owner |
| A-276 (e) | A hold keeps the lines without prices or tenders; a line with no price to sell at is refused at the hold (`QUOTE_REQUIRED`, `WEIGHT_REQUIRED`); at recall an unpriced line shows null. | Owner |
| A-276 (f) | A recall keeps the row (RECALLED) rather than deleting it; a second recall is 404. | Owner |
| A-276 (g) | The provider tender is the whole payment (`AMOUNT_DIFFERS` otherwise), so no change ever comes from it; a walk-in takes only a payment for nobody, a named customer only theirs; another branch's is answered `PAYMENT_UNKNOWN`. | Owner, Accountant |
| A-276 (h) | Only a payment taken at the sale's own shift: one with no shift or another shift is `OTHER_SHIFT`. | Owner |
| A-276 (i) | A void of a sale paid by mobile money or card is refused (`TENDER_NOT_VOIDABLE`, ORD's existing rule, which now sees the linked payment); refund it through a return. | Owner, Accountant |
| A-276 (j) | The new `HeldSale` fields are optional in the contract and always sent. | Owner |
| A-276 (k) | The seed is not extended (a parked sale on the seeded open shift, or a mobile money tender without a provider's confirmation, would not be honest seed data). | Owner |

**No existing shape changed.** Contract **2.10.0** (on top of lane B's 2.9.0), additive: three planned operations move into code, five optional `HeldSale` fields and two schemas are new, and `completeCounterSale` accepts a tender it refused before (`paymentId`).

**No ADR conflict.** ADR-0079 (proposed) is new. ADR-0077 is respected: a hold and a recall are selling, on the cashier's own open shift only; the provider tender's shift is asked through `TillShiftCheck` and held by the database through 0239's `pay.till_shift_refusal`. **The ORD exception** was used, additively only: `SaleTenderRequest.paymentId` in `src/modules/ord/application/sale-posting.ts`. **No existing PAY or ORD shape changed**, so the parent session was not asked: PAY gains one LEDGER table and one method, and its read of an order's payments answers the same for every payment that existed before (no link exists for any of them). `Receipts.reverseIn` and `reverseApprovedIn` were not touched (lane B's B09u owns BL-077 there).

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 1c (`b09b2c-pos-held-provider-tender`, from `main` at `e526e1e`), lane A.
2. **Scope:** held sales (hold, list, recall re-priced, recalled once, lapsing at the close and the force close); a mobile money or card tender at the counter only as a payment the provider cleared, linked to its sale (ADR) and allocated once through `SalePosting.postIn`.
3. **Gate:** held sales re-priced on recall with exact pesewas after a price change between hold and recall, recalled once, lapsing at the shift's close (a force close included); a provider tender only as a cleared payment, allocated once, never another customer's or another shift's.

## Contract changes

**2.10.0, minor, additive** (changelog entry and cold-read line written, above lane B's 2.9.0).
- `holdSale` (`POST /registers/{id}/held-sales`), `listHeldSales` (`GET`), `recallHeldSale` (`DELETE /held-sales/{id}`) into code (450 code operations on `main` before, 453 now; 194 planned before, 191 now; 644 in all). New code `HELD_SALE_INVALID`.
- `HeldSale`: optional `shiftId`, `status`, `heldTotalPesewas`, `pricing` (`HeldSalePricing`, new, with `HeldSalePricedLine`, new) and `currency`. Examples' `expiresAt` is twelve hours after `heldAt`.
- `completeCounterSale`: `paymentId` on a mobile money or card tender is taken; refusals `PAYMENT_INVALID` with `PAYMENT_UNKNOWN`, `NOT_A_PROVIDER_PAYMENT`, `PAYMENT_NOT_CLEARED`, `METHOD_DIFFERS`, `PAYMENT_ALREADY_USED`, `OTHER_CUSTOMER`, `OTHER_SHIFT`, `AMOUNT_DIFFERS`; `COUNTER_SALE_INVALID` gains `PAYMENT_ID_NOT_FOR_METHOD`, `PAYMENT_NAMED_TWICE`; `PROVIDER_PAYMENT_NOT_AVAILABLE` is gone.
- `Payment.order` names the sale that took a linked payment.
- Checks: `contract:generate --check`, Redocly clean, `versioning.ts` against `main`: ok.

## Built

| Area | What |
| --- | --- |
| Migrations | 0250 (pos): `pos.held_sale` (WORK), `pos.held_sale_guard`, `trg_shift_held_sales_lapsed`. 0251 (pay): `pay.payment_order_link` (LEDGER), `pay.payment_order_link_guard`. Both in the rollback walk. |
| POS | `judgeHold`, `judgeRecall`, `heldSaleExpiry`, `heldTotal` (domain); `HeldSales` (hold, list, recall, `lapseIn`); `Shifts.close` and `Shifts.forceClose` lapse the shift's holds; `CounterSales` passes `paymentId` on, refuses it on a non-provider tender or twice. |
| PAY | `judgeClearedTender` (domain); `Payments.takeClearedIn`; `PaymentStore.insertOrderLink`, `linkedOrders`; `paymentsOfOrder` and the views include linked payments. |
| ORD | `SaleTenderRequest.paymentId` (optional): a tender naming it goes through `takeClearedIn` instead of `recordIn`. |
| Docs | ADR-0079 and its index row, A-276, BL-079, API.md, the changelog, `data-model/pos.md` and `pay.md`, the POS and PAY cards, THREAT_MODEL abuse cases 3 and 4. |

## The gate, proved by running it

**Held sales (`test/integration/pos/held-sales.integration.spec.ts`, 15 tests).** Prices are read by SQL from `mdm.price_list_entry` of the version in force, never from the code under test.
- Kofi holds 3 yams and 2 cabbages on his T1 shift: by SQL the base list holds 2,000 and 1,000, so **3 x 2,000 + 2 x 1,000 = 8,000**; the answer's lines, `pricing.totalPesewas`, `heldTotalPesewas` and `pos.held_sale.held_gross_pesewas` are each 8,000; `expires_at - held_at` is exactly 12 hours; **nothing is reserved or moved** (counts of `inv.stock_reservation`, `inv.stock_movement`, orders and payments unchanged; only the hold row is new); one `HOLD_SALE` audit row by Kofi. A replay answers the first hold and writes nothing.
- Refused, holding nothing: the storekeeper and the accountant (403), another cashier and a manager on Kofi's shift (403), another till's device (403), no device (401 `DEVICE_CREDENTIAL_INVALID`), a till with no open shift (422 `SHIFT_NOT_OPEN`), a goat with no weight (`HELD_SALE_INVALID` `QUOTE_REQUIRED`), a weight without its source, a non-v7 id, an unknown field (400).
- The manager makes a POS channel list with yams at 2,300 from two hours on; the owner approves it. Two hours later Kofi recalls: by SQL yams are now 2,300 and cabbages 1,000, so **3 x 2,300 + 2 x 1,000 = 8,900**; the recall answers RECALLED, each line re-priced, `pricing.totalPesewas` 8,900 and `heldTotalPesewas` still 8,000. Another cashier and a manager were refused before it (403), recalling nothing.
- **Recalled once:** the same key replays the first answer; a new key is 404, exactly the envelope of an id that names nothing; the list no longer shows it. The recalled sale completes at the counter: by SQL the receipt is **8,900** and the cash paid 8,900.
- A hold lapses twelve hours after it was held (404, not listed). **At the declaration** every hold still on Kofi's shift becomes LAPSED (`SHIFT_CLOSED`), each audited once, the recalled one untouched, and recalling is 404. **At the force close** Ama's hold of 4 yams and a cabbage (4 x 2,300 + 1,000 by SQL) becomes LAPSED (`SHIFT_FORCE_CLOSED`) and recalling is 404.
- **The database:** a hold on a closing shift, on another till or by anyone but the shift's cashier (`ck_held_sale_open_shift`); a change to what was held and any change to a recalled or lapsed hold (HK004); a recall by another (`ck_held_sale_recall`); deleting a hold still HELD (HK004; a recalled one may be purged, as any WORK row); a shift leaving OPEN with a sale held on it (`ck_shift_held_sales_lapsed`).

**The provider tender (`test/integration/pos/provider-tender.integration.spec.ts`, 11 tests).** Against the fake Paystack, each charge approved and confirmed by its signed webhook; every figure by SQL over `pay.payment`, `pay.payment_allocation`, `bil.billing_document` and the journal lines.
- Kofi charges 4,000 on his shift; it clears. He sells 3 yams (by SQL **3 x 2,000 = 6,000**) for 4,000 mobile money naming the payment and 2,000 cash with 5,000 handed over: change **3,000**, from the cash alone. By SQL: one link (the sale, Kofi's shift, Kofi); the payment's `allocated_pesewas` 4,000 in exactly one allocation; the receipt's allocations sum to **6,000**; no new mobile money payment was written; 2200 over the payment's journals is **0**; 1200 over the receipt's and both payments' journals is **0**; the allocation's journal is exactly **Dr 2200 4,000, Cr 1200 4,000**; one `TAKE_AS_TENDER` audit row.
- **ORD sees it:** the sale and `getOrder` read `paidPesewas` 6,000, `outstandingPesewas` 0, PAID (without the link it would read 2,000 and PART_PAID); `getPayment` names the sale; a void is refused `TENDER_NOT_VOIDABLE`.
- **Refused, recording nothing** (counts of orders, payments, allocations, links, documents, journals and movements unchanged): a second allocation of the same payment (`PAYMENT_ALREADY_USED`; the database refuses a second link too); the same payment twice in one sale (`PAYMENT_NAMED_TWICE`); Adjoa's payment for Madina and for a walk-in (`OTHER_CUSTOMER`; Adjoa's own sale then takes it); a payment still pending (`PAYMENT_NOT_CLEARED`, also by the database); Ama's shift's payment and a payment on no shift (`OTHER_SHIFT`, also by the database); another branch's payment, answered exactly as an id that names nothing (`PAYMENT_UNKNOWN`, one detail each); a part of the payment and more than it (`AMOUNT_DIFFERS`); cash handed over on it (`CHANGE_ONLY_FROM_CASH`); a mobile money tender with no payment (`PAYMENT_METHOD_REQUIRES_VERIFICATION`); a payment id on cash (`PAYMENT_ID_NOT_FOR_METHOD`); the storekeeper and the accountant (403); Ama on Kofi's shift (403).
- The X report's mobile money equals the shift's cleared charges by SQL: 4,000 + 2,000 + 5,000 + 2,000 = **13,000** (the pending 2,000 never cleared), each counted once.

## Mutation checks (each applied alone, its spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | `closeShift` no longer lapses the holds | red: 3 of 15 |
| M2 | The database without `trg_shift_held_sales_lapsed` | red: 1 of 15 |
| M3 | The recall no longer refuses another cashier | red: 1 of 15 |
| M4 | The recall prices at the hold's time, not now | red: 2 of 15 |
| M5 | `judgeRecall` ignores a recalled hold | red: 1 of 15 |
| M6 | `judgeHold` no longer refuses another cashier | red: 1 of 15 |
| P1 | `judgeClearedTender` ignores another customer | red: 1 of 11 |
| P2 | The link guard ignores another shift | red: 1 of 11 |
| P3 | `judgeClearedTender` ignores a payment already used | red: 1 of 11 |
| P4 | PAY reads an order's payments without the link | red: 3 of 11 |
| P5 | `judgeClearedTender` ignores another shift | red: 1 of 11 |
| P6 | The link guard ignores a payment not cleared | red: 1 of 11 |

## Test first, as it honestly happened

- The unit tests were written first and seen red (both files failed to import) before `judgeHold`, `judgeRecall` and `judgeClearedTender` existed; then green (21 tests).
- The migrations, the application code and the two integration specs were written next. The held sales spec's first run was red, 10 of 15, all test errors: a wrong table name (`inv.reservation` for `inv.stock_reservation`) and a DELETE sent with an empty body. The provider spec's first run was red, 4 of 11, all test errors: the order view has no `payments` list (the test now asserts its paid figures, which only the link makes right), the void was asked by a cashier who lacks `ord.order.void`, and my own arithmetic counted a charge that never cleared. No assertion was weakened.
- The existing counter sale spec asserted `PROVIDER_PAYMENT_NOT_AVAILABLE`; that row now asserts `PAYMENT_UNKNOWN` for an id that names nothing, plus a new row for `PAYMENT_ID_NOT_FOR_METHOD`.
- The new contract test was red once: a TOTP code reused within its window; the test now steps thirty seconds on, as the force close test does.

## Decisions

- **ADR-0079 (proposed):** a counter sale takes a cleared provider payment by an insert-only link in PAY, never by changing the payment.
- Everything else is in A-276.

## Security review (hakorem-security-review)

The same finding goes into the pull request body.
- **Boundary:** TB3 (the POS device: hold, recall, the counter sale), TB2 (the back office: the list), TB5 (the provider's confirmation the tender rests on), TB8 (the database: the new guards).
- **The standards, item by item:** SC-01 strict zod bodies (the held payload is a strict object; an unknown field is 400), exact integers; SC-02 every handler authorises in the application layer at the till's branch and location, deny by default, the shift's own cashier only for a hold and a recall, wrong roles tested, all three join the handler walk and the identifier walk (a recall of another branch's or an unknown id answers the same 404; another branch's payment answers as an unknown id); SC-03, SC-04 parameterised SQL only; SC-05 kernel `Money` and the engine's `extendPrice`, rounding once at the line; SC-06 idempotency on both writes, a replay answers the first; SC-07, SC-08 audit and events carry ids and pesewas only, no phone number; SC-14 no external call in a business transaction (the charge was sent before the sale; the sale only reads its confirmed state); SC-15, SC-16 no empty catch, stable codes with details; SC-17 not a maker-checker change; SC-22 `pay.payment_order_link` insert-only, the cleared payment untouched; SC-23 serializable writes under the shift's and the payment's row locks (the recall takes the shift's lock before the hold's, the order a close takes them in); SC-24 hold, recall, lapse and the tender all audited.
- **Money paths:** a mobile money or card tender is only a payment the provider confirmed (callback or lookup), never a client's status; it is taken whole so no change comes from it; another customer's, another shift's, another branch's, a pending one and a second use are refused in the handler and by `pay.payment_order_link_guard`, each mutation-checked.
- **Not applicable, with reason:** SC-09 to SC-11 (existing cookies, CSRF and CORS), SC-12 (no upload), SC-13 (no webhook change), SC-18 (no restricted field), SC-19 (no outbound URL), SC-20, SC-21 (CI scans).
- **Abuse case 4:** the control is extended to the counter and tested. **Residual:** a refused provider tender leaves no item on the exception report's source (only the 422 and the authorisation log); the cleared payment stays on the unmatched and unallocated queue until a sale or a refund takes it. Parked as **BL-079** for B12's report. **Abuse case 3:** a held sale holds no price; the recalled sale's override is judged again when it is sold.

## Deferred

- **BL-079:** a refused provider tender on the exception source (B12).
- **B09b continued 2:** a held sale offline lives on the device only (OFFLINE_SYNC 2), nothing to sync.

## Contract requests

The frontend's `main` was read at `678f8c9`; it holds CR-001 to CR-044, the same as at B09b continued 1b. No new request.
- **CR-042, CR-043, CR-044:** lane B's B09u (ADR-0026 Amendments). **CR-039 to CR-041:** lane B.
- **CR-031, CR-032 point 6, CR-038:** B09b continued 2. **CR-032 points 1 to 5:** B09b continued 3. **CR-033 points 1 and 2:** B09b continued 4.
- **Everything else:** answered in earlier phases.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | 1,631 tests passed (161 in POS and PAY). |
| Integration (full suite) | First run: 136 files, 1,735 of 1,740 passed; the 5 red were one cause in `database-roles.integration.spec.ts`: `pos.held_sale` is WORK and every WORK table grants `hk_app` DELETE, which I had withheld. Fixed in its own commit (DELETE granted for a purge of recalled or lapsed holds; deleting a HELD one refused, HK004, tested), not by changing the check. Second run: **136 files, 1,740 tests passed.** |
| Contract | 47 files, 124 tests passed (after the TOTP fix in the new test). |
| Coverage | No pricing, ledger, stock valuation or distribution code changed; the 100 percent gates are CI's. |
| Lint (boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check`, versioning | Clean. |
| End to end, setup, the image, the scans, the rollback of the last migration | Run in CI. |

Nothing was re-run to turn red into green.

## Gate

**Passed:** a held sale is re-priced on recall with exact pesewas after a price change between hold and recall (8,000 held, 8,900 recalled, each derived by SQL from the entries in force, and the completed sale's receipt 8,900), recalled once (404 the second time), lapsing at the shift's declaration and at its force close, held by the database too; a mobile money or card tender at the counter is only a payment the provider cleared, allocated once (in the handler and the database), never another customer's or another shift's (nor another branch's, a pending one, or with change), each mutation-checked.

## Notes for the frontend track

- **2.10.0.** The till can park a sale (`holdSale`), list a till's parked sales and recall one (`recallHeldSale`, DELETE): show `pricing` on the recall (the prices now) beside `heldTotalPesewas` (the total when held), and complete it with `completeCounterSale`, which prices it again. A 404 on recall means the hold is gone (recalled, lapsed with the shift or expired).
- **Mobile money at the counter:** start the charge with `initiateMobileMoneyCharge` naming the shift, wait for it to clear (`checkPaymentStatus`), then send its `paymentId` on the tender with `amountPesewas` equal to the payment's amount; never put change on it.

## CI

- **`eb9db97`** (the code head before the merge slot, pull request #107, on `main` at `e526e1e`): run **44247705509 (push)** succeeded and run **44247754024 (pull_request)** succeeded.
- **`0349df4`** (the code and docs head after the rebase on `main` at `39c6198` and the renumbering, pull request #107): run **44261106960 (push)** succeeded and run **44261112871 (pull_request)** succeeded. Nothing was re-run.
- Locally after the rebase: unit 1,643 passed; integration 141 files, 1,768 tests passed; contract 47 files, 125 tests passed; lint, typecheck, Redocly, `contract:generate --check` and versioning clean.
- The runs on the head that adds this report are named in the closing message to the parent session, because a report cannot name the runs of the commit that adds it. The pull request merges only when every run on its head is green.

## Next session

B09b continued 2, copied from `docs/prompts/session-openers.md` (unchanged by this phase).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b2c-pos-held-provider-tender.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0013, ADR-0015, ADR-0027, A-273 in docs/ASSUMPTIONS.md, and the abuse cases 4, 10 and 11 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 2 only, on branch b09b3-pos-offline-sync, branched from main: the settings of
OFFLINE_SYNC 5.2 seeded; the offline pack (getOfflinePack) with CR-031 (OfflineProduct.taxInclusive from each product's
price list) and CR-032 point 6 (the pack's CASH_MOVEMENT reason codes); offline sync (syncOfflineSales): exactly-once by
client UUIDv7, the gap-free device counter, provisional references, occurred-at and recorded-at, cash-only tenders
offline, the stock exception instead of a refusal, price override bounds re-checked at sync, shift open and cash
movements from the queue, SyncResultItem.grossPesewas (null when nothing was recorded) and its currency (CR-031). Write
the five conflict tests ADR-0027 names (animal sold elsewhere, animal on hold, countable stock gone negative, sale in a
locked period, missing device counter) and the 500-transaction test with the network disabled, each figure derived
independently by SQL over the journal lines and stock movements. Run scenario 6 of docs/UAT.md as a dry run and record
any difference.
The owner's addition (1) to A-200 (2026-11-16), test-first: an offline sale synced later is issued at its occurred_at,
the time it happened at the till, not the sync time. Extend Billing.issueIn additively to take that time for a synced
sale only, mark the document as synced from offline (a field the receipt and the document read show), and bound how old
an offline sale may be (a setting, conservative default, recorded in ASSUMPTIONS.md): a sale outside the bound is still
recorded, never refused (a synced sale is always recorded), and reaches the exception report; a sale whose period has
since locked posts on the first open date, flagged, keeping its occurred_at (ADR-0027 point 6).
Nothing in sync refuses a sale: a stock conflict, an old sale, a locked period each records the sale and raises an
exception. Test each.
CR-038 (owner, 2026-11-17, placed here by the B9b split, A-273 (a)): the till sells a product in more than one unit, each
at its own price, a crate or a single egg. `OfflineProduct.sellingUnits`: one entry per unit sold at the register,
`saleUom` first, each priced by its own price list entry, never derived from another unit's price. `CounterSaleLine.uom`
(on the counter sale B09b continued built and on the offline sale): absent means `saleUom`; convert to the base unit for
stock through `MasterDataRefs.toBaseIn`, and re-price by that unit's entry at sync. A unit the product is not sold by is
`VALIDATION_FAILED` on `/lines/{i}/uom`. A return refunds in the unit sold (say so in `createReturn`'s description).
Test-first with exact pesewas, at a crate and a single egg of the seeded eggs, online and offline. Unit names and CR-040
are B09c's.
The clock tolerance (owner, 2026-11-17, A-273 (g)): 300 seconds. A synced sale whose till time is outside it is recorded
and flagged (the sale and the exception report's source show it), never refused. Test it at 301 seconds either way.
Stop at the gate and write docs/sessions/B09b3-pos-offline-sync.md.
```
