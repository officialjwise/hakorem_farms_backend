# B10 continued 6: margin over the selling price, a possible staff acceptance by address and browser, and the Storekeeper's order read (lane B)

Date: 2026-11-23 · Branch `b10c6-margin-staff-acceptance-storekeeper`, from `main` at `33f8082` (#126, lane A's B09b continued 4c) · Status: **gate passed locally; CI below.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-342 | **Margin over the selling price (decision 4).** The only margin computed in code was QUO's `marginPercent`, over cost: it is markup. It keeps its value and its name for one release, deprecated (LOUD), beside `markupPercent`; the margin is the new `marginOverPricePercent`, (net less cost) over net, the net with the delivery fee before tax, as UAT scenario 2 reads it (30.75, 30.77), derived on read from the stored net and cost. The floor setting (no stored or seeded row; the default 1,000 applies) is read over price, not converted: the same number over price is always at least as strict, so every quote that passed the old check passes or now needs approval, and none that failed it passes. The floor is judged on the product lines alone, without the fee (the more conservative of the two figures). The column `margin_percent` is named markup in its comment; its rename is BL-098 (expand then contract). | Owner |
| A-343 | **A possible staff acceptance by address and browser (decision 5, A-325 (a) and (c) withdrawn).** No staff cookie is read in QUO (the cookie reader and the route through `AuthenticationService` are removed; a test walks QUO's source). QUO asks IAM's one new read `StaffSessionsSeen.fromAddressIn`, at read committed before the decision's transaction, for staff sessions **created from the decision's address** (`iam.session.ip_created`, the only address IAM keeps) and **last seen no earlier than 24 hours before**, by the application clock, the edge inclusive, revoked or not. **The same address in another browser is flagged too**, marked `sameBrowser: false` (it flags, never blocks, so the more visible reading). Each match is a row of `quo.quote_link_staff_match` (LEDGER) and the decision publishes `quo.QuoteLinkDecidedFromStaffAddress` (the staff, each with `sameBrowser`; no address, user agent, session or token), replacing `quo.QuoteLinkDecidedInStaffBrowser`. B12's kind stays `QUOTE_ACCEPTED_BY_STAFF`. Residual: a session that moved address after it was created is not matched. | Owner |
| A-344 | **The Storekeeper's order read (decision 6, A-335 decided).** `getOrderFulfilmentView` (`GET /orders/{id}/fulfilment-view`, `ord.order.read.fulfilment`: the Storekeeper, the Manager and the Owner), authorised in `Orders.getForFulfilment`, answering its own schema built by allow-list: lines, quantities, weights, delivery details, the customer's name and the pick lists; never a price, total, payment, credit, tax, terms, salesperson, shift or `pendingConsent`. Only at a branch the caller holds it for whole (a grant limited to a location does not read the branch's orders); another branch's order 404, as an unknown id. No list of orders for the store (the pick list names the order). | Owner |

**No ADR conflict.** ADR-0001 is followed (integer pesewas, half-up once, no stored rate: the margin over price is derived on read); ADR-0017 and ADR-0035 (the Storekeeper's read authorised in the application layer, deny by default, wrong roles refused and tested); ADR-0067 (the 24-hour window is the application clock's, no `now()` in business SQL); ADR-0074 and ADR-0087 (no token carried by the flag). **Lane A's files were not touched:** `sale-posting.ts` and its types, PAY's till-cash rules, INV's negative-stock functions and all of POS are unchanged. IAM changed only by the one additive read the parent session allowed (`StaffSessionsSeen`, a new interface, a new Postgres reader, one provider and one export) and two additive migrations (the new permission and its grants); no IAM table, column or behaviour changed.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B10 continued 6, lane B (`b10c6-margin-staff-acceptance-storekeeper`, from `main`), inserted by the owner's decisions of 2026-11-23 before B11 continued 2.
2. **Scope:** decisions 4 (margin over price), 5 (a possible staff acceptance by address and browser) and 6 (the Storekeeper's order read), test-first; decisions 1 to 3 and the further decisions as records in the openers only; BL-107 if it fit.
3. **Gate:** every margin shown or stored is over price and markup is named markup, UAT scenario 2's 30.75 and 30.77 exact, a quote that passed the old floor but fails the new one needs approval; a decision through a link from the address of a staff session active in the last 24 hours flagged naming the staff, never blocked, no staff cookie read; the Storekeeper's own branch-only read with no money, another branch 404, the full read still refused; every write refuses the wrong role. **Passed** (below).

## Contract changes

**2.29.0, minor, LOUD on one field's name and one behaviour** (on top of lane A's 2.28.0; Redocly clean, no warnings; `contract:generate`: 524 operations from code, 134 planned, 658 in all).
- **Response fields (always sent), `QuoteVersion`:** `markupPercent` (over cost, on the product lines) and `marginOverPricePercent` (over the net with the delivery fee, before tax).
- **Deprecated, LOUD:** `QuoteVersion.marginPercent` is markup; its value and meaning are unchanged (always equal to `markupPercent`), kept one release (BL-098). The quote examples, which showed the margin over price under that name, are corrected.
- **Behaviour, LOUD (`issueQuoteVersion`):** the margin floor is read over price, judged on the product lines without the fee: 264,000 over a cost of 240,000 (10.00 percent markup) now waits; 266,668 clears.
- **New operation:** `getOrderFulfilmentView` with the new schemas `OrderFulfilmentView` and `OrderFulfilmentViewLine`; new permission `ord.order.read.fulfilment` in `x-seeded-roles` (the Owner, the Manager, the Storekeeper).
- **Behaviour, no shape changed:** `acceptQuoteByLink` and `declineQuoteByLink` read no cookie; a decision from a staff session's address within 24 hours is flagged, never refused (descriptions say so).
- **Description:** CST's planned `MarginRow.marginPercent` is over revenue (its examples already were).
- No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| The sweep (decision 4) | Code: QUO's `marginPercent` was the only margin computed, over cost; PUR's order-splitting "margin" is a closeness band, untouched; INV and ORD only mention the floor in comments. Contract: `QuoteVersion.marginPercent` (over cost: renamed by a new field, deprecated), `MarginRow.marginPercent` (planned CST, already over revenue: described). Data model: `quo.quote_version.margin_percent` (markup: comment, BL-098), `cst.margin_fact` (amounts only, no rate). Docs: SRS FR-QUO-003 and FR-QUO-005 and SA-06 (now over price, with the new acceptance figures), API.md, GLOSSARY (Margin, Markup, Margin floor), `data-model/quo.md`, UAT step 2.2 (the basis named; 30.75 and 30.77 were already over price). |
| QUO domain | `quote.ts`: `markupPercent` (over cost), `marginPercent` (over price, never above 100, null with no cost or no price), `judgeMargin` over price exactly in integers, `versionFigures` with both figures; `staff-match.ts` (`matchStaff`, `staffWindowStart`, `STAFF_MATCH_WINDOW_HOURS`). |
| QUO application and interface | `Quotes`: the view's three figures; the approval's summary over price; `linkWrite` asks IAM's `StaffSessionsSeen` before the decision's transaction and records the matches; `quo.QuoteLinkDecidedFromStaffAddress` replaces `quo.QuoteLinkDecidedInStaffBrowser`. Removed: `staff-cookie.ts`, `IamStaffSessions` (the route through `AuthenticationService` and `ModuleRef`), the controller's `Request`. `PgQuoteStore.insertStaffMatches`. |
| IAM (one additive read, the parent session's leave) | `StaffSessionsSeen` (token `STAFF_SESSIONS_SEEN`), `PgStaffSessionsSeen`, provided and exported, in `index.ts`. |
| ORD | `Orders.getForFulfilment`, `fulfilmentViewOf` (allow-list), `OrderFulfilmentView`; `getOrderFulfilmentView` on `OrdersController`. |
| Schema | 0307 (QUO: `margin_percent` named markup, `below_margin_floor` described); 0308 (QUO: `quo.quote_link_staff_match` LEDGER, `ck_quote_link_decision_no_cookie` NOT VALID); 0309 and 0310 (IAM: `ord.order.read.fulfilment` and its grants). Each with a tested rollback (the archive-link rollback walk). |
| Docs | A-342 to A-344; A-325, A-335, A-337 to A-341 and SA-06 statuses; ADR-0092 Accepted (file and index); abuse case 40; BL-098; `data-model/quo.md`; the IAM, QUO and ORD cards; API.md; the 2.29.0 changelog; the openers (this phase inserted, the owner's decisions written into B11 continued 2, B12 and B13, the reference table and the lane B order); four ADR-0026 Amendments lines. |

## The gate, proved by running it

**Margin (decision 4).** Unit, `quo/domain/quote.spec.ts` (written first and run red: 20 failed before the code): UAT scenario 2's **30.75** (1,906,000 over 1,320,000) and **30.77** (1,716,000 over 1,188,000) through `marginPercent` and through `versionFigures` with the 6,000 fee and 1,200 tax; 1,700,000 over 1,428,000 is a margin of 16.00 and a markup of 19.05; the half-up edges (1/800 is 0.13, 1/801 is 0.12, -1/800 is -0.13); a nil cost 100.00; the largest amount; the floor at 1,586,666 (below) and 1,586,667 (clear) over 1,428,000; **1,570,800, at the old floor over cost, now below**; a fee never lifting a version over the floor. Integration, `quotes.integration.spec.ts`: a draft at 264,000 over 240,000 shows margin 9.09, markup 10.00 (and 10.00 under the deprecated name), is below the floor and **answers 202 `QUOTE_BELOW_MARGIN`** where it issued before; the stored `margin_percent` 10.00 and its column comment "Markup over cost"; the versions now at 266,668 (clear, 10.00 shown) and 266,664 (202, 10.00 shown, compared exactly).

**A possible staff acceptance (decision 5).** `test/integration/quo/possible-staff-acceptance.integration.spec.ts` (6), each case from its own address: a staff member signed in from `.31` in the buyer's browser an hour before: the acceptance stands (200 ACCEPTED), **one match naming that staff member, same browser**, the flag with the staff, `sameBrowser`, `windowHours` 24 and `abuseCase` 40 and no address, user agent, session id or token; **the same address in another browser** (a decline): flagged, `sameBrowser: false`; **another address** with the salesperson's live staff cookie in the browser: no match, no flag, nothing taken from the cookie, and `quo.QuoteLinkDecidedInStaffBrowser` never published; **last seen 24 hours and a second before**: no flag; the database: matches insert-only (42501, HK001), one per session (23505), the window 24 (23514), a decision row with a staff session refused (23514); **no staff cookie read anywhere in QUO** (a walk of `src/modules/quo` for the cookie name, `Cookie`, `AuthenticationService` and `ModuleRef`: none). `quote-links.integration.spec.ts`: a browser holding a live staff session (accept and decline) records no staff. Unit, `quo/domain/staff-match.spec.ts` (8, run red first: no module): the window's edge inclusive and a millisecond outside, another browser, unknown browsers, 500 characters, no address, a session created after, one per session in order.

**The Storekeeper's order read (decision 6).** `test/integration/ord/storekeeper-order-read.integration.spec.ts` (4), over the seeded trading day: the Storekeeper reads a seeded order: exactly the allow-listed keys, every line's id, number, quantity and unit as stored, the delivery details as the full read has them, and **no key anywhere matching pesewas, payment, paid, outstanding, credit, price, total, tax, currency, terms, billing, variance, discount or deposit** (the full read of the same order carries them); **another branch's Storekeeper 404, as for an unknown id**; the Storekeeper still **403 on `getOrder`, `listOrders` and `getOrderCreditCheck`**; the Cashier, Sales, the Driver and the Accountant 403; the Manager 200. The authorisation walk (a user with no grant 403) and the seeded role matrix include it.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The floor judged over cost again (`judgeMargin`) | red: 4 (unit) |
| M2 | The margin shown on the lines alone, without the fee | red: 5 (unit) |
| M3 | The floor judged on the net with the fee | red: 1 (unit) |
| M4 | No window in the domain (`matchStaff`) | red: 1 (unit) |
| M4b | No window in the domain and IAM's read widened to 1,000 hours | red: 1 (integration: the 24 hours and a second case) |
| M5 | Two unknown browsers called the same browser | red: 1 (unit) |
| M6 | The Storekeeper's read without its own-branch 404 (the branch check left to `authorise`, 403) | red: 1 (integration) |

## Test first, as it honestly happened

- `quote.spec.ts`'s new margin and floor tests were written and run red (20 failed) before `quote.ts` changed; `staff-match.spec.ts` red (no module) before `staff-match.ts`.
- The integration specs were written after the application code, against the gate's list, then run; each passed on its first run, so mutations M4b and M6 were applied to show they can fail (red as listed). One mutation attempt (removing the window's SQL parameter) broke the query itself and was discarded as no evidence; M4b replaced it.
- `quotes.integration.spec.ts`'s figures at the old floor were changed because the rule changed (the owner's decision): 264,000 became 266,668 for the clear case and 66,666 a head for the 202 case, and 264,000 now has its own test that it waits. Nothing was skipped, no assertion was loosened, and nothing was re-run to turn red into green.

## Security review (hakorem-security-review, applied to the new paths)

- **Boundary:** TB1 storefront (the quote link) and TB2 back office (the store's read).
- **Sessions and browser:** staff cookies stay `__Host-`, host-only on the console; QUO reads none (tested by a source walk and by a request carrying a live staff cookie). Nothing in the change sets or widens a cookie.
- **Authorisation:** `getOrderFulfilmentView` declares its own permission and authorises in `Orders` (deny by default; wrong roles, another branch and the full read tested); IAM's new read authorises nothing and is called only by QUO for the decision's own address.
- **Data:** the match table is CONFIDENTIAL (DC-27: who was signed in where), insert-only; the outbox flag carries no address, user agent, session id or token (tested). The store's read carries the delivery details the owner named and no money.
- **Abuse paths:** abuse case 40 updated (control, detection, residual). No new abuse path: the store's read narrows what a Storekeeper could have been given.
- **Not applicable here:** payments, webhooks, uploads, exports (no such path changed).

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since B10 continued 4)

- **CR-056 item 2** (the Storekeeper's `ord.order.read` for the order it picks): **implemented differently, as the owner decided** (A-335): its own narrower read `getOrderFulfilmentView`, never `ord.order.read`. Items 1 and 3 were built in B11 continued; item 4 (the drivers' list) is B11 continued 2's.
- **CR-059** point 4's `QUOTE_ACCEPTED_BY_STAFF`: its source is now `quo.QuoteLinkDecidedFromStaffAddress` (the staff, each with `sameBrowser`); B12 builds the kind and the report. **CR-059 to CR-062 remain B12's, larger, and are written into B12's opener with the owner's decisions of 2026-11-23.**
- **CR-060** point 2 (margin per crate): over price, as decided here; B12's.
- **CR-055, CR-057, CR-054 point 1:** B11 continued 2's, in its opener. **CR-053, CR-058:** done. **CR-050 part 1, CR-051, CR-052:** lane A's. Older requests are answered in their phases.

## Tests (this machine)

Run on commit `53287a4` (the code of the final head; the commits above it change only docs), with Docker's Testcontainers; see CI below for the runs on the pushed commits.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **3,979 passed, 334 files, none skipped, exit 0** (993 s), the whole integration suite included. Coverage, whole: statements 94.06, branches 83.66, functions 97.87, lines 97.08 (each gate 80). **Every full-coverage gate holds at 100 percent** (the run exits 0 on them); QUO's domain has no gate of its own |
| Unit alone | 1,913 passed, 163 files |
| Contract (`pnpm test:contract`) | 138 passed, 55 files, on the final contract (2.29.0), after the operation counts, the seeded role matrix and the authorisation walk were given the new operation |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (`contract:generate` unchanged after the commit: 524 operations from code, 134 planned) |

## Deferred

- **BL-107** (ORD refusing `OFFLINE_PACK_PRICE` on an online sale or override): **left in the backlog.** The counter sale's reason check is in `src/modules/ord/application/sale-posting.ts`, lane A's file, which this lane may not edit; building only `createOrder`'s half would leave the till open and look done. Lane A or the parent session should schedule it with that file.
- **BL-098** (new): rename `margin_percent` to `markup_percent`, drop the deprecated `marginPercent`, and widen the column (numeric(9,2) overflows above 9,999,999.99 percent markup), the release after 2.29.0.
- A list of orders for the store (A-344 (d)); the last-seen address of a session (A-343 (e), IAM's authentication path, lane A's).

## Questions for the owner

1. **The floor on the product lines alone (A-342 (c)).** The margin shown includes the delivery fee (as UAT step 2.2 reads it); the floor is judged without it, so a fee never lifts a quote over it. Agreed, or should the floor use the figure shown?
2. **The same address in another browser (A-343 (c))** is flagged, marked not the same browser. Agreed, or flag only the same browser?
3. **A location-limited Storekeeper (A-344 (c))** does not read the branch's orders. Agreed?

## Notes for the frontend track

- **2.29.0:** show `marginOverPricePercent` as the margin and `markupPercent` as markup; stop reading `marginPercent` (deprecated, it is markup). Expect more quotes to need approval at the same floor.
- The Storekeeper's order page reads `getOrderFulfilmentView` (no prices, no totals, no payment); 404 for another branch.
- Nothing changes for the buyer's link pages.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 2, copied from `docs/prompts/session-openers.md` (updated by this phase).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B10c6-margin-staff-acceptance-storekeeper.md),
and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued, which this phase continues).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (fulfilment), DEL and NTF requirement blocks of docs/SRS.md (nothing else
from the SRS), docs/data-model/ord.md, del.md and ntf.md, the ORD, DEL, NTF and PAY cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0021, ADR-0026 (the abandoned-cart assignment), ADR-0074 (a link
sent by message gets its own token from the sending worker, never one stored in the outbox), ADR-0075 (the egg cost
rule's running-total rounding), ADR-0077 (cash through a till only through its open shift), ADR-0091 and ADR-0092 (dispatch
loads the vehicle; the driver's cash is a payment held by the driver), and the abuse cases 6, 43 and 44 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 2 only, on branch b11c-driver-run-returns-notifications. B11 built picking and packing (2.25.0,
A-332 to A-336); B11 continued built dispatch of a whole delivery order (the document on the weighed quantity, the
deposits allocated, a lighter total refunded, the cash due fixed, the goods onto the vehicle), the delivery, the driver's
own reads and the proof with the cash collected held by the driver on 1020 (2.27.0, A-337 to A-341, ADR-0092): build on
them, never again. The rest, in this order:
1. The driver's run and cash. Routes (createRoute, getRoute, listRoutes, reorderRouteStops, startRoute, getMyRoute; CR-057
   point 2, what a driver with no run gets), the drivers' list for dispatch (CR-056 item 4) and `del.route.*` for the
   Manager and the Owner; assignDelivery and reassignment, audited (FR-DEL-004); markOnTheWay; recordFailedDelivery,
   returnDeliveryToStock (from the vehicle to the returns hold, with the credit note and refund as applicable),
   rescheduleDelivery and cancelDelivery; delivery slot booking against capacity under a row lock, zone cut-offs and
   rescheduling (FR-DEL-001 to FR-DEL-003; the slot table and generation exist from B7, ADR-0026); CR-055, a part
   delivery (`ProofOfDeliveryCreate.lines` and `returnedReasonCode`: the rest back to stock or kept for a reattempt,
   the document credited for what came back, the cash due fixed again); the driver's offline sync (syncDriverEvents,
   idempotent by client id, CR-057 point 3: a DUPLICATE answers the first outcome); the driver's cash summary and the
   driver cash reconciliation by someone else (FR-DEL-010, 6900 for a variance, `DRIVER_VARIANCE` for B12); CR-057, the
   hand-in at a till shift: the parent session gives leave for one additive POS operation and its tests, which takes
   the cash only through the existing deciding function (tillTakesCash, ADR-0077 with the owner's late-entry amendment)
   onto the receiving cashier's own open shift, never a second cash path, each collection (a `pay.payment` held by the
   driver) handed in exactly once, its cash counted at that shift's close (A-212 (a)); test it with exact pesewas,
   including a short hand-in. Lane A's payInvoiceAtTill (#124, A-285 (g)) is the nearest pattern: reuse its shift check,
   never copy it. PAY's `Payment.driver` (BL-096). Partial fulfilment and backorders (FR-ORD-012) with the delivery fee
   once, on the first dispatch, never again (UAT scenario 2's rule, A-331 (b), steps 2.12 and 2.13, test with exact
   pesewas); an order on account dispatched with its due date from the customer's terms (WHL, through a port: ORD sits
   below WHL; A-338 (a)); collectFulfilment (a collection order handed over and paid at the till); the checkout's
   store-credit choice for a lighter total (ADR-0021, A-338 (c)); a delivered order completed once later settled
   (BL-097); cracked eggs written off on the pick (CR-054 point 1, through INV's adjustment path and its approval).
2. Returns of eggs (owner, 2026-11-18, ORD, test-first with exact pesewas): a return is refunded at the price actually
   paid on that sale line, never the current price list. Part of a crate returned as single eggs (five cracked eggs) is
   refunded pro rata at the crate's price per egg, never at the single-egg price, with the running-total rounding of the
   egg cost rule (ADR-0075, half-up, never half-to-even): each return's refund is round(paid x cumulative returned / per
   crate) less round(paid x previously returned / per crate), so the pieces always add up. Tests by SQL: a GH₵55.00 crate
   (5,500 pesewas) with five eggs returned refunds exactly 917 (5,500 x 5 / 30 = 916.67, half-up); a crate returned one
   egg at a time, all 30, refunds exactly 5,500 in total, never more; a mutation using the single-egg price, or rounding
   each egg on its own, turns a test red. Lane A's B09b continued 2 adds to createReturn's description that a line is
   returned in its sold unit; extend it to a part of a crate returned as single eggs.
3. Notifications (NTF): through the outbox (SMS, WhatsApp, email, in-app) with templates, triggers, preferences, opt-out,
   quiet hours, the message log and retry: the customer's messages from `ord.OrderDispatched` (one, with the weights and
   the final total, FR-ORD-011), the on-the-way and delivered messages (FR-DEL-012, once per event and recipient),
   abandoned-cart messaging (ADR-0026), the death report sent back by the malware scan (B06r, A-175: liv.MortalityReturned
   names the reporter and the reason), the document sends (ADR-0062, A-204: sendBillingDocument and sendStatement, 202
   through the outbox, a bil.reprint_log row with the channel, the archived bytes or a lasting link, never a new
   document; the remittance advice from pur.SupplierRemittanceReady, once per payment; a send reaches only the document's
   own customer or supplier and a failed send is retried without a second archive row), CR-033 point 3 (the receipt SMS
   once when a counter sale with customerPhone syncs, with a fresh server-made token for a sale whose till token was
   refused, ADR-0074; the refused till token still opens nothing), and the guest's SMS tracking link with its own long
   random token (a guessed token or the order's id answers 404). CR-039 at the shop (the crate and the single egg, each
   at its own price; CartLineAdd.uom; test-first with exact pesewas).
Run steps 1.11 to 1.16 of docs/UAT.md, the driver case in scenario 5 and scenario 2 from step 2.12 as a dry run and
record every difference. CR-056's Storekeeper order read was built in B10 continued 6 (A-335 decided, the owner
2026-11-23): its own narrower read, never `ord.order.read`.
The owner, 2026-11-23 (decisions 1 and 2, on A-337 and A-338):
- A-337 is approved, plus: a run cannot be closed while goods remain on the van. Every item is delivered, returned to
  stock or written off with a reason, and anything unaccounted for goes on the driver variance report. Test the refusal
  to close a run with goods still on the van, each of the three ways out, and the variance line.
- A-338: a guest's order gets a receipt: approved. Dispatch on credit terms is NOT deferred past launch: wholesale
  credit buyers are the main delivery customers. Build it here: the credit check runs at dispatch (WHL's credit control
  through a port, ORD sitting below WHL), and the invoice is issued from the quantities actually dispatched, with its
  due date from the customer's terms; remove `CREDIT_DISPATCH_NOT_AVAILABLE` LOUD.
The owner, 2026-11-23 (from the frontend's F12 and F10n, with notifications): list the message templates so a reminder
level picks one instead of typing a code, and record each reminder's delivery per channel (sent, delivered, failed), so
a failed reminder shows as failed.
For B12's reused photographs (the owner, 2026-11-23): `platform.stored_file` already keeps each upload's SHA-256; record
on the proof of delivery whether its photograph or signature matches an earlier upload (as liv.MortalityPhotoReused
does for a death photograph) and publish it for the exception report. If this phase does not, B12 must; say which in the
report.
Stop at the gate and write docs/sessions/B11c-driver-run-returns-notifications.md.
```
