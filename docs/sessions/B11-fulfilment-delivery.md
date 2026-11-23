# B11: order fulfilment and picking (lane B), split before dispatch

Date: 2026-11-23 · Branch `b11-fulfilment-delivery`, from `main` at `5fdc2c4` (#122, lane A's B09b continued 4) · Status: **the first part's gate passed locally; the phase split (A-336); CI below.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-332 | **A pick names its stock and moves none (ADR-0091).** Checked against the pick location's promisable stock plus the order's own reservations there, in the base unit (a catch-weight pack takes its weighed kilograms); below zero offers nothing (ADR-0081). Stock and journals move once, at dispatch. The order line carries its picked figures until dispatch fixes them. A catch-weight line goes whole on one pick list. A pick location is physical, live and of the order's branch, never in transit, a van, a site or the returns hold. | Owner |
| A-333 | **A line not sent as ordered:** its stock released where the order holds it for that line alone, else left for dispatch or cancellation; its picks withdrawn and pick list lines cancelled. A substitute is priced by the engine on the order's channel when proposed and reserved when accepted, or the answer is refused `STOCK_UNAVAILABLE` with nothing changed; never a product priced by the kilogram. | Owner |
| A-334 | **The customer's answer:** staff record a phone, in-person or WhatsApp answer only when they did not ask (held by the database too); the customer answers in their account; one question per order; a higher total asked by `recordPicks` itself and withdrawn when a swap brings the line back; a refused higher total sends the order back to picking and is not asked again at the same total; a refused substitute or smaller quantity cancels the line, and the last line the order (`OUT_OF_STOCK`, refund asked for); the short pick is its own question (`proposeShortPick`, CR-054 option 2). | Owner |
| A-335 | **B11's first grants (CR-056 items 2 and 3):** the Storekeeper `ord.fulfilment.read` and `ord.fulfilment.pick`, **not `ord.order.read`** (CR-056 asked it "for the order it picks"; a grant cannot be limited to one order and would open every order's prices and each customer's credit position, `getOrderCreditCheck`, to the store: put to the owner); the Manager and the Owner both fulfilment permissions and `ord.order.update`. Dispatch, the Driver and delivery permissions come with dispatch. | Owner |
| A-336 | **B11 split at its first sub-domain boundary.** Everything after packing moves to **B11 continued** (`b11b-dispatch-delivery`), inserted before B12. | Parent session |

**No ADR conflict.** ADR-0021 is followed at pick exactly (the weighed total `half_up(price x kg)` once; within the tolerance it proceeds; above it the picker swaps or the customer is asked; below it the picker is prompted and it may go at the lower total); its dispatch half is B11 continued's. ADR-0019: no reservation is changed by a pick; ADR-0081: a balance below zero offers nothing to a pick. ADR-0067: no `now()` in business SQL (the times come from the application clock; `created_at` defaults are the standard columns). ADR-0091 is new (Proposed). Lane A's files were not touched: `sale-posting.ts`, PAY's till-cash rules and INV's negative-stock functions are unchanged; in POS only `completeCounterSale`'s **example** gained the two new `SalesOrder` fields, which the contract requires of every `SalesOrder` example (no POS code changed). The POS hand-in leave (CR-057) is unused here and passes to B11 continued.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11, lane B (`b11-fulfilment-delivery`, from `main`); planned to split at the first sub-domain boundary the context would not get past.
2. **Scope built:** pick lists (FR-ORD-008, CR-053), picks with weight capture (FR-ORD-009), catch-weight re-pricing and consent beyond tolerance (FR-ORD-010), substitutions with consent and the short pick (FR-ORD-013, CR-054 points 2 and 3), packing (FR-ORD-011's first half), cancellation while picking (FR-ORD-014's B11 part), CR-056's Storekeeper and Manager grants.
3. **Gate of this part:** a catch-weight order re-prices at pick with exact pesewas and waits for the customer's consent beyond its tolerance; a short pick packs only with agreement; a pick never takes a location below zero or stock promised to someone else; every write refuses the wrong role and the wrong branch. **Passed** (below). The rest of B11's gate (cash on delivery against the driver; the outbox's customer notification) is B11 continued's.

## Contract changes

**2.25.0, minor, LOUD on two behaviours** (on top of lane A's 2.24.0; Redocly clean, no warnings; `contract:generate`: 516 operations from code, 139 planned, 655 in all).
- **Into code:** `listFulfilments`, `createFulfilment`, `getFulfilment`, `recordPicks`, `packFulfilment`, `cancelFulfilment`, `proposeSubstitution`, `recordCustomerConsent`, `answerMyOrderConsent`, each described in full. **New:** `proposeShortPick` (`POST /orders/{id}/short-picks`, `ShortPickCreate`). **New error code** `FULFILMENT_INVALID` (its details in `docs/API.md`).
- **Request (optional):** `listFulfilments?orderId`; `FulfilmentCreate.lines`; `PickRecord.withdraw`; `SubstitutionCreate.uom`; `ConsentRecord.kind` gains `SHORT_PICK`.
- **Response (always sent):** `SalesOrder.fulfilments` and `SalesOrder.pendingConsent` (new `OrderPendingConsent`); `PickListLine.status`, `pickedQty`, `pickedWeightKg`, `minimumWeightKg`, `maximumWeightKg`, `toleranceState`.
- **LOUD:** `PendingConsent.kind` gains `SHORT_PICK` and `CustomerOrder.pendingConsent` is now filled; `cancelOrder` cancels a `PICKING` or `AWAITING_CUSTOMER` order where it answered 422 (`ord.OrderCancelled.fromStatus` widened).
- No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| Schema | 0293 (platform lookup): the `FULFILMENT` document type, `PCK-…`. 0294 (ORD): `ord.fulfilment`, `ord.pick_list_line`, `ord.fulfilment_line`, `ord.order_consent` with `ck_fulfilment_number`, `ck_fulfilment_order`, `ck_fulfilment_transition`, `ck_pick_list_line_cap`, `ck_fulfilment_line_cap`, `ck_fulfilment_line_weight`, `ck_order_consent_shape`, `uq_order_consent_pending`, `ck_order_consent_answered` (the asker never answers by phone, in person or WhatsApp), `ck_order_consent_transition`. 0295 and 0296 (IAM, additive lookup and grant rows). Each has a tested rollback (the archive-link rollback walk). |
| ORD domain | `picking.ts` (`pickedLineTotal`, `toleranceLimits`, `judgeWeighed`, `judgePickedQuantity`, `pickWeightSource`, `readyToPack`); `line-numbers.ts` (`nextLineNumber`, `byLineNumber`, `accraDay`); `judgeCancellation` admits PICKING and AWAITING_CUSTOMER. |
| ORD application | `Fulfilments` (create, list, get, recordPicks, pack, cancel, proposeSubstitution, proposeShortPick, recordConsent, `answerMineIn`); `order-extras.ts` (an order's pick lists and its waiting question for `SalesOrder`); `OnlineOrders.answerMine` and the customer's `pendingConsent` in words; `OrderReversals.cancelForCustomerIn` and the cancellation ending pick lists and a waiting question. Events `ord.CustomerConsentRequested`, `ord.CustomerConsentAnswered`, `ord.FulfilmentPacked`. |
| ORD infrastructure and interface | `PgFulfilmentStore`; `FulfilmentsController`, `OrderFulfilmentController`, `MyOrderConsentController`; the zod bodies; the ten fragments. |
| Docs | ADR-0091 (indexed); A-332 to A-336; abuse case 42; `data-model/ord.md`; the ORD card; `API.md` (ORD and the error catalogue); the 2.25.0 changelog entry; the openers (B11 marked split, **B11 continued** inserted before B12, CR-053 placed in B11 in the first commit); ADR-0026 Amendments (two lines). |

## The gate, proved by running it

**`test/integration/ord/fulfilment.integration.spec.ts` (20 tests), over the seeded farm.** Hand figures: beef MEAT-0005 online 3,213 a kg, 15 kg packs, tolerance 10 percent; two packs estimate 30.000 kg and 96,390, the most without consent 96,390 + 9,639 = **106,029**, the limits 27.000 and 33.000 kg.
- **Re-priced at pick:** a pick list `PCK-…-DDW-…` of the confirmed cash-on-delivery order at the cold room moves it CONFIRMED to PICKING; packs of 15.200 and 15.600 kg answer **30.800 kg and 98,960** (98,960.4 half-up once over the line; each pack alone 48,838 and 50,123), `SCALE`, within tolerance; replayed by key the same answer; resent pick ids stored once; a reused id 422 `PICK_ID_REUSED`; a third pack `PICK_OVER`; an unweighed pack `WEIGHT_REQUIRED`.
- **Consent beyond tolerance:** a pack swapped for 18.800 kg takes the line to **34.000 kg and 109,242**: the order AWAITING_CUSTOMER, `pendingConsent` `HIGHER_TOTAL` at 109,242, one `ord.CustomerConsentRequested` in the outbox, packing refused `CONSENT_PENDING`; swapped back to 15.000 kg (**30.200 kg, 97,033**) the question is withdrawn by the system and the order picks on; above again, asked again. The Storekeeper recording the answer 403; the wrong kind `CONSENT_KIND_MISMATCH`; the Manager's phone answer moves the order to PICKING and the pick list packs at 109,242, the order PACKED, `ord.FulfilmentPacked` once; a late pick `INVALID_STATE_TRANSITION`.
- **Never below zero, never another's stock:** with the cold room's 45 kg all promised (30 to the first order, 15 to the second), a 20.000 kg pack for the second is `STOCK_SHORT` and nothing is written; 13.000 kg (below 13.500) is `BELOW`, `MANUAL`, and packs at **41,769**.
- **Short pick only with agreement (CR-054):** two crates of three picked, packing refused `SHORT_PICK_NOT_AGREED` at `/pickList/1`; `proposeShortPick` two crates; a second question `CONSENT_PENDING`; the customer (Tema Cold Store's sign-in) sees it in `getMyOrder` and agrees with `answerMyOrderConsent` (`CUSTOMER_ACCOUNT`); the pick list packs at two.
- **Refusals:** a refused smaller quantity on a one-line order cancels the line and the order (`AWAITING_CUSTOMER>CANCELLED`), its pick list cancelled, its pick withdrawn, its reservations released; the person who asked cannot record the answer (`CONSENT_ASKER_CANNOT_ANSWER`); `cancelOrder` on a picking order ends its pick list with no stock movement.
- **Substitute:** the same product refused `SAME_PRODUCT`; a unit the substitute is not sold by (the line's crate for yam) `UNIT_NOT_SOLD`; two tubers of yam accepted on WhatsApp: the crate line SUBSTITUTED and its eggs released, the yam line written at the engine's price (its total exactly twice the unit price), reserved `2.000`, naming the line it replaces, and put on the open pick list.
- **Roles and branches (CR-056):** the Cashier, the Driver and Sales are 403 on every write and read; another branch's Manager 403 by id and an empty list by order; no session 401; an unknown pick list 404; a customer's answer on another customer's order 404, with nothing waiting 422 `NO_CONSENT_PENDING`.
- **The database:** a pick list asking more than ordered HK010; a pick above its pick list HK010; a pick changed HK004; deleted 42501; a pick list moved PICK_LIST to PACKED HK004 and CANCELLED back HK004; a second waiting question 23505; an answer by its asker 23514; a substitution without its proposal 23514; a pick list of a PLACED order 422; a virtual location `NOT_A_PICK_LOCATION`.

**Unit:** `picking.spec.ts` (24: FR-ORD-009's 86,240 from 15.200 and 15.600 kg at 2,800; FR-ORD-010's 30.800 within, 34.000 above 33.000, 26.000 below 27.000; both limits within; a gram either side; exact half 2.500 kg at 3 is 8, 2.499 is 7, 2.501 is 8; rounding once over the line; a total a pesewa above the most shown; a zero tolerance; inexact limits rounded inward; the pack rules), `line-numbers.spec.ts`, `reversal.spec.ts` amended.

**Contract:** `test/contract/b11/fulfilment.contract.spec.ts` (a pick list, its picks, a short pick, its answer, a refused pack, the list and the order against 2.25.0). **Walks extended:** the authorisation walk (ten operations; `answerMyOrderConsent` among the caller's own), the identifier walk (`answerMyOrderConsent` 404 for another customer's order and a made-up one), the rollback walk (0293 to 0296), the operation counts, the request-schema check.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | Each pack priced and rounded on its own (`pickedLineTotal`) | red (unit) |
| M2 | The most the customer was shown ignored (`judgeWeighed`) | red (unit) |
| M3 | The minimum weight rounded down instead of up | red (unit) |
| M4 | The stock check at pick switched off | red: 3 |
| M5 | A line above its tolerance never asked about | red: 3 |
| M6 | The asker allowed to record the answer (application check removed; the database still refuses it, as a 500) | red: 1 |
| M7 | Packing without its rules (`readyToPack` ignored) | red: 2 |
| M8 | `cancelOrder` not ending the pick lists | red: 2 |
| M9 | `cancelFulfilment` not authorised at the pick list's branch | red: 2 |

## Test first, as it honestly happened

- **Domain first, red first:** `picking.spec.ts` was written and run red (the module did not exist) before `picking.ts`.
- **The integration spec was written after the application code**, against the gate's list, then run: the first run failed on one expectation of mine (the zone waives the delivery fee on an order this size: 96,390, not 97,890) and cascaded through its describe; after that fix all 20 passed. The mutation table above is the proof that each test can fail. Two walks then failed on bodies they had no example for (fixed in `test/support/routes.ts`),. The whole suite then failed once, in `whl/credit-control`: the Storekeeper's new `ord.order.read` opened `getOrderCreditCheck` to it. That was a real leak, not a test to rewrite: the grant was withdrawn (A-335) and the test stands unchanged.
- **A flaky ordering, found and fixed (its own commit, `fix(ord)`):** after the grant change, the fulfilment spec failed one local run in three on which of two packs recorded in one request came first. Cause: both share `recorded_at`, and the reads then ordered by the client ids, which a phone makes in any order. Fix: each pick is numbered on its pick list in the order recorded (`ord.fulfilment_line.line_no`, unique per pick list) and every read orders by it. Proved by making it fail on purpose: the spec now gives the second pack an id that sorts first; red before the fix (`expected [ [ '15.600', 50123 ], …(1) ] to deeply equal [ [ '15.200', 48838 ], …(1) ]`), green after, three runs in a row. The red runs were local; no CI run was red.
- **Nothing was re-run to turn red into green; no assertion was weakened and nothing was skipped.**

## Security review (hakorem-security-review's checklist, applied to the new paths)

- **Authorisation:** every handler authorises in the application layer at the order's or pick list's branch, deny by default; wrong roles and another branch refused and mutation-checked; the customer's answer only on their own order (ownership through MDM's customer of the sign-in), on the identifier walk.
- **Maker and checker:** the person who asked a question never records its answer by phone, in person or WhatsApp (application and database, ADR-0091); new abuse case 42, its events `ord.CustomerConsentRequested` and `ord.CustomerConsentAnswered` for the daily exception report (`CONSENT_RECORDED_BY_STAFF`, B12).
- **Stock:** a pick never takes more than the pick location holds that nobody else is promised; withdrawn picks and cancelled pick lists are kept; nothing is deleted (`hk_app` has no DELETE).
- **Money:** the weighed total is integer pesewas, half-up once at the line; the tolerance compares exact integers; a substitute's price is the engine's.
- **Data:** the new tables are DC-22 (`ord.*`), CONFIDENTIAL; `CustomerOrder.pendingConsent` carries what the customer is asked to pay and no price record.
- **Not applicable here:** uploads, payments, webhooks, exports (B11 continued's proof-of-delivery photographs and cash).

## UAT dry runs

Not run in this part: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from step 2.12 all need dispatch, delivery or the driver, which are B11 continued's; its opener keeps them.

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since B10 continued 4)

- **CR-053:** built (`listFulfilments?orderId`, `SalesOrder.fulfilments`, `SalesOrder.pendingConsent`).
- **CR-054:** points 2 and 3 built (`proposeShortPick` with `SHORT_PICK` consent; a quantity below `qtyToPick` is recorded and the pick list packs only at the agreed quantity; `SubstitutionCreate.uom` with `UNIT_NOT_SOLD`). **Point 1** (cracked eggs written off on the pick) moves to B11 continued with its opener.
- **CR-056:** items 2 and 3's picking grants built (A-335), **declining the Storekeeper's `ord.order.read`** for the reason in A-335 (the owner decides); the Driver, `del.*`, `ord.fulfilment.dispatch` and the drivers' list are B11 continued's.
- **CR-055, CR-057:** B11 continued's (in its opener, with the parent session's leave for the one POS operation).
- **CR-058:** done in PR #117 (A-323).
- **CR-059 to CR-062:** RPT and B12's; **larger, named for the parent session to schedule with B12**.
- **CR-050 part 1, CR-051, CR-052:** lane A's POS. Older requests are answered in their phases.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`), on `9aab973` (main had not moved) | **3,871 passed**, 320 files, none skipped: the whole integration suite once, in 846 seconds. Statements 94.04 percent, branches 83.69 (the gate is 80), functions 97.84, lines 97.03; every 100 percent gate held. The first whole run, on `31b375d`, was red on 1 test (`whl/credit-control`, the Storekeeper's grant: fixed in `9aab973`, see above). |
| Unit alone | 1,860 passed, 156 files |
| Contract (`pnpm test:contract`) | 135 passed, 54 files (after the request-schema check was given the eight new bodies; that file alone then 7 of 7) |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean |

## Deferred

To **B11 continued** (its opener): dispatch and collection with the invoice on the weighed quantity, the deposit and the delivery fee once (A-331 (b)), backorders, CR-054 point 1, all of DEL, CR-055 to CR-057, returns of part of a crate, NTF (templates, triggers, preferences, opt-out, quiet hours, sends, the receipt SMS, the tracking SMS, the document sends, the death report's return), abandoned-cart messaging, CR-039 at the shop, the UAT dry runs and the seed of a fulfilled order. Backlog: none new.

## Questions for the owner

1. **A refused higher total (A-334 (e)):** the order goes back to picking for a lighter pack, never cancels itself. Agreed?
2. **Who records the customer's answer (A-334 (a)):** never the person who asked, unless the customer answers in their account or by a signed link. Agreed?
3. **A pick moves no stock until dispatch (A-332, ADR-0091).** Agreed?
4. **The Storekeeper and `ord.order.read` (A-335):** CR-056 asks for it "for the order it picks", but a grant opens every order's prices and each customer's credit position. Keep it withheld, or grant it (and decide whether the credit check should then need a permission of its own)?

## Notes for the frontend track

- **2.25.0:** the order page reads `SalesOrder.fulfilments` and `pendingConsent` (send `recordCustomerConsent` with `pendingConsent.kind`); the pick list shows `pickedQty`, `pickedWeightKg`, `minimumWeightKg`, `maximumWeightKg` and `toleranceState` (`BELOW` is the prompt to add a pack); a swap is one `recordPicks` with `withdraw` and the new pick; a short line is `proposeShortPick`, never a substitution; a substitute in another unit sends `uom`. The customer's order page shows `pendingConsent` and answers with `answerMyOrderConsent`. `cancelOrder` now works while picking. Dispatch is not yet built.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued, copied from `docs/prompts/session-openers.md` (this phase inserted it).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11-fulfilment-delivery.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (fulfilment), DEL and NTF requirement blocks of docs/SRS.md (nothing else
from the SRS), docs/data-model/ord.md, del.md and ntf.md, the ORD, DEL and NTF cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0021, ADR-0026 (the abandoned-cart assignment), ADR-0074 (a link
sent by message gets its own token from the sending worker, never one stored in the outbox) and the abuse case 6 in
docs/security/THREAT_MODEL.md, and ADR-0091 (a pick names its stock and moves none; dispatch moves it). Use
docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued only, on branch b11b-dispatch-delivery. B11 built pick lists, picks with weights, the
catch-weight re-pricing at pick and the customer's consent beyond tolerance, packing, substitutions, the short
pick (CR-054 points 2 and 3), CR-053 and cancellation while picking (contract 2.25.0, A-332 to A-336): build on
them, never again. The rest: dispatch with the invoice on the weighed quantity (dispatchFulfilment and
collectFulfilment: consume the order's reservations and issue the picked stock from the pick location in the
same transaction, never taking a location below zero online, ADR-0091; allocate the deposit; refund an
overpayment or fix the amount due on delivery; ord.fulfilment.dispatch to the Manager and the Owner), partial
fulfilment and backorders (FR-ORD-012), cracked eggs written off on the pick (CR-054 point 1, through INV's
adjustment path and its approval), delivery slot capacity and booking, zone cut-offs and rescheduling (the slot table and generation
exist from B7, per ADR-0026), routes, drivers, proof of delivery, cash on delivery with the amount due fixed at
dispatch and the driver reconciliation by someone else, the driver's offline sync, notifications through
the outbox (SMS, WhatsApp, email, in-app) with opt-out and templates, and, as ADR-0026 proposes,
abandoned-cart messaging. Run steps 1.11 to 1.16 of docs/UAT.md and the driver case in scenario 5 as a
dry run and record any difference.
Notify the maker of a death report sent back by the malware scan (B06r, A-175): liv.MortalityReturned names
the reporter and the reason; the Farm hand reads no death record, so this message is how they learn of it.
Build the document sends on NTF (ADR-0062, A-204): sendBillingDocument and sendStatement (202 through the outbox,
a bil.reprint_log row with the channel for a billing document, the archived bytes or a lasting link, never a new
document), the remittance advice to the supplier from pur.SupplierRemittanceReady (FR-PUR-013, once per payment), and
a test that a send reaches only the document's own customer or supplier and that a failed send is retried without
a second archive row.
The owner, 2026-11-16 (A-212 (a)): a driver's delivery cash is handed in at a till shift and counted at that shift's close,
never typed in outside one.
CR-033 point 3: the receipt SMS is sent once, through the outbox and NTF, when a counter sale that carried customerPhone
syncs, with the receipt link B9b built, the official number and the sale reference; the sync result or the order says
whether it was sent, and a replayed sync never sends it twice. A sale whose till token was refused as reused (B9b,
owner 2026-11-17) gets its SMS with a fresh server-made token, issued by the worker just before the provider call
(ADR-0074), so the customer still gets a working receipt; test that the refused till token still opens nothing.
The launch path for online orders (owner, 2026-11-17): guest checkout with a phone number and an SMS tracking link. Send
the tracking link by SMS through the outbox and NTF when a guest order is placed, carrying its own long random token
(B09q: no ID is ever a key), and test that a guessed token or the order's id answers 404.
CR-039 (owner, 2026-11-17, F10f), when the shop opens: the shop sells a product in more than one unit, each at its own
price (the crate and the single egg). ProductDetail.sellingUnits and CatalogueItem.sellingUnits, saleUom first, each
priced by its own entry and never derived; CartLineAdd.uom (absent means saleUom), kept on the cart line, priced by it
at checkout and placement, with stock reserved in the base unit; a crate and a single egg of one product are two cart
lines. Test-first with exact pesewas.
Returns of eggs (owner, 2026-11-18, ORD, test-first with exact pesewas): a return is refunded at the price actually
paid on that sale line, never the current price list. Part of a crate returned as single eggs (five cracked eggs) is
refunded pro rata at the crate's price per egg, never at the single-egg price, with the running-total rounding of the egg
cost rule (ADR-0075, half-up, never half-to-even): each return's refund is round(paid x cumulative returned / per crate)
less round(paid x previously returned / per crate), so the pieces always add up. Tests: a GH₵55.00 crate (5,500 pesewas)
with five eggs returned refunds exactly 917 (5,500 x 5 / 30 = 916.67, half-up); a crate returned one egg at a time, all 30,
refunds exactly 5,500 in total, never more; a mutation using the single-egg price, or rounding each egg on its own, turns a
test red. Lane A's B09b continued 2 adds to createReturn's description that a line is returned in its sold unit; B11
extends it to a part of a crate returned as single eggs.
The owner, 2026-11-19 (from the frontend's F11; the numbers checked on the frontend's main at 5242161):
- CR-056: grant B11's permissions in the seed (the Storekeeper's and the Manager's picking grants are B11's, A-335). A Driver sees and records only their own runs and may upload
  proof-of-delivery photographs only; a Storekeeper picks and packs; a Manager plans runs and dispatches. Each grant
  gets a wrong-role refusal test and an other-driver's-run refusal test.
- CR-057: the driver hands delivery cash in at a till shift. Add the operation: the till records each collection
  handed in, against the driver's run, and the driver variance report shows anything short. It is never typed in as
  loose cash. The cash goes only onto the receiving cashier's own open shift, through PAY's TillShiftCheck (ADR-0077),
  and each collection is handed in exactly once. Test it with exact pesewas, including a short hand-in. POS is lane
  A's: the parent session gives B11 leave for this one additive POS operation and its tests, keeping lane A's till-cash
  rules unchanged.
- CR-053: built in B11.
- CR-054: built in B11 (points 2 and 3: proposeShortPick and SubstitutionCreate.uom); point 1, cracked eggs on the
  pick, is this phase's.
- CR-055: recording a part delivery.
- The part-crate return rule above stands.
UAT scenario 2's rule for a partial dispatch (B10 continued 5, A-331 (b), open with the owner): a delivery fee is charged
once, on the first dispatch of an order, never again on a later one; test it with exact pesewas (steps 2.12 and 2.13),
and finish scenario 2's dry run from step 2.12, recording every difference.
Stop at the gate and write docs/sessions/B11b-dispatch-delivery.md.
```
