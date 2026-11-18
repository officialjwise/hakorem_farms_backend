# Session openers

The exact opening message for each remaining backend session, B2 to B13. Paste one into a fresh Claude Code session **opened in `backend/`** (`~/Desktop/hakorem-farms/backend/`), after the previous session's pull request is merged. Opened there, the session loads the sixteen `hakorem-*` skills from `backend/.claude/skills/`; opened at the workspace root it does not (A-079, confirmed by the owner on 2026-11-14). Every path in an opener is relative to `backend/`; the frontend's contract requests are at `../frontend/docs/CONTRACT_REQUESTS.md`.

Each opener follows the pattern B0 set in `docs/sessions/B00-architecture.md` ("Next session") and the session protocol in `docs/SHARED_BRIEF.md`: read `CLAUDE.md`, the shared brief and only the session's section of `docs/BUILD_PROMPT.md`; read only the latest report in `docs/sessions/`; from B4 onward read the frontend's contract requests; confirm phase, scope and gate in three lines; execute that session only; stop at the gate; write `docs/sessions/<ID>-<slug>.md`.

## How to use this file

1. Open the Claude Code session in `backend/`. Check that the previous session's report exists in `docs/sessions/` and its pull request is merged.
2. Open `docs/sessions/<previous>.md`, section "Next session". **If it differs from the opener here, the report wins**: the previous session knew what actually happened. Update this file afterwards so the two agree.
3. Paste the message from the fenced block, nothing before or after it.
4. When the session ends, check its report's "Next session" message against the next opener here.

## Reference table

| Session | Report | Branch | BUILD_PROMPT section | Gate |
| --- | --- | --- | --- | --- |
| B2 | `B02-foundation.md` | `b02-foundation` | B2 — Foundation | One-command setup works on a clean machine; CI green |
| B3 | `B03-platform-slice.md` | `b03-platform-slice` | B3 — Platform and the first vertical slice | The slice passes all four test layers; the frontend logs in against the real API |
| B4 | `B04-master-data-pricing.md` | `b04-master-data-pricing` | B4 to B12 | A price resolves for every band, channel and tier; an unresolvable request becomes a quote |
| B4 continued | `B04c-master-data-continued.md` | `b04c-master-data-continued` | B4 to B12 | The tax calculator's exact cases pass (built; the session split, A-097) |
| B4 continued (d) | `B04d-master-data-promotions.md` | `b04d-master-data-promotions` | B4 to B12 | Promotions stack by their rules and a coupon limit holds under concurrency (built; the session split, A-103) |
| B04d continued | `B04d-continued-master-data.md` | `b04d-continued-master-data` | B4 to B12 | Every catalogue write refuses the wrong role; the catalogue, price lists, tax scheme and promotions are seeded through services, and `calculateTax` answers on a fresh setup (built; the session split, A-108) |
| B04d continued 2 | `B04d2-parties-locations.md` | `b04d2-parties-locations` | B4 to B12 | Every branch, location, customer and assignment write refuses the wrong role; branches, locations and customers are seeded through services, and nothing in the MDM seed is written as SQL (built; the session split, A-114) |
| B04d continued 3 | `B04d3-reference-data.md` | `b04d3-reference-data` | B4 to B12 | Every remaining master data write refuses the wrong role; reason codes are a fixed list; `quoteDelivery` returns a zone's exact fee or "delivery unavailable"; the payment methods, zones and their seed are written through services (built) |
| B4 continued (e) | `B04e-iam-carry-overs.md` | `b04e-iam-carry-overs` | B4 to B12 | User, role-reading and grant administration refuse the wrong role; the IAM seed is written through the IAM services (built; the session split, A-121) |
| B04e continued | `B04e2-auth-approvals.md` | `b04e2-auth-approvals` | B4 to B12 | Role writes, the approval endpoints, customer registration and phone verification, and password reset with CR-004 point 3's error codes are live, each with a wrong-role refusal (built) |
| B04e continued 2 | `B04e3-file-store-imports.md` | `b04e3-file-store-imports` | B4 to B12 | The file store with uploads, the malware scanner and `evidence_file_id` are live, each with a wrong-role refusal (built; the session split, A-125) |
| B04e continued 3 | `B04e4-product-images-imports.md` | `b04e4-product-images-imports` | B4 to B12 | Product images attach through the file store with compressed public variants and a hidden original, each write with a wrong-role refusal (built; the session split, A-127) |
| B04e continued 4 | `B04e5-mdm-imports-exports.md` | `b04e5-mdm-imports-exports` | B4 to B12 | MDM's imports and exports run with a dry run that writes nothing, apply all or none, and audit exports with their row count, step-up above the bulk threshold and a signed expiring link, each write with a wrong-role refusal (built for the customer sheet; the session split, A-129) |
| B04e continued 5 | `B04e6-mdm-import-sheets.md` | `b04e6-mdm-import-sheets` | B4 to B12 | The product, supplier, location and price list entry sheets import with a dry run that writes nothing and apply all or none through each entity's own service, and export audited with their row count, each with a wrong-role refusal (built) |
| B5 | `B05-inventory-ledger.md` | `b05-inventory-ledger` | B4 to B12 | The movement ledger and its database invariants, each proved by its own test; valuation at 100 percent; a lot traces both ways (built; the session split, A-131) |
| B05 continued | `B05b-inventory-documents.md` | `b05b-inventory-documents` | B4 to B12 | On-hand from movements matches a hand count of the seeded farm; a lot traces both ways over the API; every goods receipt write refuses the wrong role (built; the session split, A-138) |
| B05 continued 2 | `B05c-inventory-control.md` | `b05c-inventory-control` | B4 to B12 | Every movement reversal, transfer and adjustment write refuses the wrong role; an adjustment at or above the threshold waits for a different person; a transfer balances received plus variance to dispatched (built; the session split, A-140) |
| B05 continued 3 | `B05d-inventory-counts-holds.md` | `b05d-inventory-counts-holds` | B4 to B12 | A stock take posts its variances from blind counts, overlapping cycle counts are refused, a hold blocks a sale until released, each write with a wrong-role refusal (built; the session split, A-143) |
| B05 continued 3b | `B05d2-inventory-reservations-exceptions.md` | `b05d2-inventory-reservations-exceptions` | B4 to B12 | An expired reservation is released by the job exactly as reserved, under concurrency; one active reservation per animal; an exception is resolved through the adjustment path; each write with a wrong-role refusal (built; ADR-0048 built with it, A-145) |
| B05 continued 4 | `B05e-inventory-cold-chain-opening.md` | `b05e-inventory-cold-chain-opening` | B4 to B12 | The B5 gate in full: on-hand from movements matches a hand count of the seeded farm; stock cannot go negative outside allowed types; a lot traces both ways; every INV write refuses the wrong role |
| B05x | `B05x-dashboard-branches-labels.md` | `b05x-dashboard-branches-labels` | B4 to B12 | getOwnerDashboard answers in one request with its sourceless figures null and listed; every tile whose data exists answers exactly on the seeded farm, the rest are contract-only and scheduled; a branch deactivates with its refusals and lists stay within grants; lot and product label data answers; every operation refuses the wrong role (built) |
| B6 | `B06-livestock-processing.md` | `b06-livestock-processing` | B4 to B12 | A processing order produces lots whose costs sum exactly to input cost plus direct processing cost (built; the session split, A-154) |
| B06m | `B06m-master-data-requests.md` | `b06m-master-data-requests` | B4 to B12 | The draft price list preview answers exactly by the engine's identity and refuses the wrong role; price list examples agree; CR-011 answered (built) |
| B06 continued | `B06b-livestock-packs.md` | `b06b-livestock-packs` | B4 to B12 | Every LIV write built refuses the wrong role; a withdrawal hold blocks sale and processing and nobody releases it early; mortality at or above the threshold waits for a photograph and a different approver; feed and veterinary cost spread by head-days sum exactly to the value issued (built; the session split, A-158) |
| B06 continued 2 | `B06c-livestock-growth-breeding.md` | `b06c-livestock-growth-breeding` | B4 to B12 | Every remaining LIV write refuses the wrong role; a move starts only where the animal is; average daily gain and feed conversion match a hand calculation; a batch closes only when empty; a birth registers its offspring at nil cost linked to the dam; the feed, medicine and ration seed is counted by hand (built) |
| B06 continued 3 | `B06d-packs-labels.md` | `b06d-packs-labels` | B4 to B12 | Pack weights equal the lot weight and a pack label encodes the lot and the weight; a completed order reverses only while its outputs are unsold; every pack write refuses the wrong role; the Farm hand sees no cost on any LIV or PRC operation its grants reach (built) |
| B06u | `B06u-uom-conversions.md` | `b06u-uom-conversions` | B4 to B12 | Alternative units convert exactly, an inexact factor is refused by the database, conversions list in the contract, writes refuse the wrong role (built) |
| B7 | `B07-procurement-suppliers.md` | `b07-procurement-suppliers` | B4 to B12 | Three-way match blocks payment on disagreement (built; the session split, A-165) |
| B07 continued | `B07b-supplier-register.md` | `b07b-supplier-register` | B4 to B12 | A payout change waits for a different approver and the old details stay in force; a disguised document is refused; a rejected requisition cannot be converted; every write refuses the wrong role (built; the session split, A-167) |
| B07 continued 1b | `B07b2-supplier-credit-scores.md` | `b07b2-supplier-credit-scores` | B4 to B12 | A credit note cannot exceed its invoice's uncredited amount; an approved variance lets a mismatched invoice be paid; a payment's remittance data is answered once; the score matches a hand calculation; every write refuses the wrong role (built) |
| B06r | `B06r-processing-reversal-approval.md` | `b06r-processing-reversal-approval` | B4 to B12 | A processing reversal waits for a second approver at or above the threshold and is refused once a pack is sold or moved; a farm hand finds an animal by tag, reports and submits a death with its EVIDENCE photograph, and a manager approves it whatever its value; a reused photograph is flagged (built) |
| B07 continued 2 | `B07c-storefront-checkout.md` | `b07c-storefront-checkout` | B4 to B12 | The shared sort pages without skipping or repeating; checkout reserves stock and releases it on timeout; a live animal cannot be added to a cart; the catalogue exposes no cost; every staff write refuses the wrong role (built; the session split, A-179) |
| B07 continued 3 | `B07c3-console-sort.md` | `b07c3-console-sort` | B4 to B12 | The four console lists sort through the shared keyset by CR-019's fields, each indexed, any other 400, and page without skipping or repeating; every read refuses the wrong role (built; six fields declined, A-181) |
| B8 | `B08-ledger-billing.md` | `b08-ledger-billing` | B4 to B12 | Trial balance sums to zero on a seeded day; an unbalanced journal is rejected by the database; numbering is gap-free under concurrent load (built and passed; the session split after its gate, A-187) |
| B08 continued | `B08c-ledger-interface.md` | `b08c-ledger-interface` | B4 to B12 | An entry written inside a savepoint keeps its lines; every chart and period operation refuses the wrong role and the Owner approving their own reopen; a period locks, closes and refuses postings through the API (built; the session split, A-189) |
| B08 continued 1b | `B08c1b-journals-rules-banks.md` | `b08c1b-journals-rules-banks` | B4 to B12 | Every journal, manual journal, rule and determination operation refuses the wrong role and a maker approving their own manual journal or rule change; a manual journal posts nothing until a different person approves it, then exactly one balanced entry as entered; `fin.ManualJournalApproved` has its matrix row (built; the session split before its bank accounts, A-192) |
| B08 continued 1b2 | `B08c1b2-bank-accounts.md` | `b08c1b2-bank-accounts` | B4 to B12 | Every bank account operation refuses the wrong role; a bank account's number is stored encrypted and shown only as its last four digits; a supplier payment naming a bank account posts to that account's own subledger party (built; ADR-0057, A-193, A-194) |
| B08 continued 1c | `B08c1c-statements-assets.md` | `b08c1c-statements-assets` | B4 to B12 | The four statements tie to the trial balance on the seeded day, each read refusing the wrong role; year close leaves 3200 at zero and 3100 increased by the year's profit; the cash figure answers from the ledger (built; the session split before fixed assets, A-198) |
| B08 continued 1c2 | `B08c1c2-fixed-assets.md` | `b08c1c2-fixed-assets` | B4 to B12 | Depreciation spreads exactly and posts once per period under concurrent runs; every fixed asset write refuses the wrong role; disposal posts its exact gain or loss; the statements still tie on the seeded day (built; ADR-0059, A-199) |
| B08 continued 2 | `B08c2-billing-documents.md` | `b08c2-billing-documents` | B4 to B12 | A billing document posts exact levy lines and a fourth levy needs data only; numbering stays gap-free under concurrent issue; the trial balance still sums to zero on the seeded day (built; the session split before rendering and the archive, A-201) |
| B08 continued 2b | `B08c2b-documents-archive.md` | `b08c2b-documents-archive` | B4 to B12 | A reprint is byte-identical apart from its reprint marker and the archive's hash holds; every issued document of the seeded day is archived once; a template version keeps issued documents unchanged; every write refuses the wrong role (built; the session split before statements, A-203) |
| B08 continued 2c | `B08c2c-statements-remittance.md` | `b08c2c-statements-remittance` | B4 to B12 | A supplier remittance advice is rendered from the data fixed with `pur.SupplierRemittanceReady` and archived once, linked from the payment; a template preview renders without archiving or numbering anything; every preview and archive read refuses the wrong role (built; the session split before statements, A-206; sends moved to B11, ADR-0062) |
| B9a | `B09a-order-core-payments.md` | `b09a-order-core-payments` | B4 to B12 | Every payment edge case in the brief passes; an order on any channel posts stock, document, payment and ledger in one transaction (sale posting built and proved; the session split, A-209) |
| B09a continued | `B09a2-payments-provider.md` | `b09a2-payments-provider` | B4 to B12 | Every payment edge case in the brief passes; a webhook is accepted only signed, in its window, unseen and with its amount re-verified; every PAY write refuses the wrong role (built; the session split, A-211) |
| B09a continued 1b | `B09a2b-payments-reconciliation.md` | `b09a2b-payments-reconciliation` | B4 to B12 | A cheque clears 1130 to 1100 or bounces and reopens its item; a reversal posts the mirror of its journal with a different approver; store credit is never redeemed beyond its balance; the trial balance still sums to zero; every PAY write built refuses the wrong role (built; the session split before settlement and bank reconciliation, A-213) |
| B09a continued 1c | `B09a2c-payments-settlement.md` | `b09a2c-payments-settlement` | B4 to B12 | A settlement of three payments with a fee posts 1100, 6910 and 1120 exactly and an extra line raises a break; a bank transfer clears only from its matched statement line; a break resolves only through an approved posting; the trial balance still sums to zero; every reconciliation write refuses the wrong role (built; the session split before the refund against a credit note, A-215) |
| B09a continued 1d | `B09a2d-payments-credit-refunds.md` | `b09a2d-payments-credit-refunds` | B4 to B12 | A refund against a credit note on a paid document posts Dr 1200, never beyond the credit note's amount less what was refunded, held by the database under concurrency, approved by someone other than both makers; a cheque is refunded through a bank payout; the trial balance still sums to zero (built, A-216, ADR-0066) |
| B09a continued 2 | `B09a3-orders-online.md` | `b09a3-orders-online` | B4 to B12 | The real Paystack sandbox run: every edge case against Paystack's test mode, every difference reported and fixed in the fake and the adapter test-first; the Settlements API's answer recorded; CR-029 (`Cart.checkoutId`) built (built; the session split before the order endpoints, A-219) |
| B09t2 | `B09t2-dates-from-clock.md` | `b09t2-dates-from-clock` | B4 to B12 | No seed row or test depends on a fixed calendar date real time will pass; the suite passes forced to 2026-12-31 and 2027-03-01 apart from named container-clock artifacts; the refund payout check uses an application-written instant; merged before 2026-12-01 |
| B09a continued 2b | `B09a3b-orders-online.md` | `b09a3b-orders-online` | B4 to B12 | Built and split (A-224, A-225): every ORD read and write built refuses the wrong role and another branch; an order is entered PLACED priced by the engine to the pesewa; a confirmation reserves every line or keeps the order PLACED naming each shortfall, the last stock confirmed once under concurrency |
| B09a continued 2c | `B09a3c-orders-reversals.md` | `b09a3c-orders-reversals` | B4 to B12 | The order endpoints and online placement post through SalePosting in one transaction; a void needs a supervisor who is not the cashier; a return never exceeds what was sold; the dashboard's sales figures answer exactly; every ORD write refuses the wrong role |
| B09a continued 2d | `B09a3d-orders-returns.md` | `b09a3d-orders-returns` | B4 to B12 | Built and split (A-228, A-229): a return never exceeds what was sold less what was returned, by trigger under concurrency, and is refunded against its own credit note by a different approver; every return write refuses the wrong role |
| B09a continued 2e | `B09a3e-orders-online.md` | `b09a3e-orders-online` | B4 to B12 | Built and split (A-230, A-231): a price outside the band or below list beyond the seller's limit is approved by a different user, on createOrder and on the sale posting alike, held by the database; the proforma is issued once and posts nothing; every new write refuses the wrong role |
| B09a continued 2f | `B09a3f-orders-online.md` | `b09a3f-orders-online` | B4 to B12 | Built and split (A-232, A-233): an online order is placed from a checkout and confirmed in the clearing's transaction only by its own money, the checkout's hold handed to it whole; it is cancelled when the hold ends first or the charge fails; the customer reads only their own orders; every ORD write refuses the wrong role |
| B09a continued 2g | `B09a3g-dashboard-seed.md` | `b09a3g-dashboard-seed` | B4 to B12 | The dashboard's six B9a figures and two tiles answer exactly from completed orders through a published view, every wrong role refused; the seeded trading day posts through SalePosting and keeps the B5 hand count and the trial balance (built) |
| B09x | `B09x-contract-requests.md` | `b09x-contract-requests` | B4 to B12 | Every list operation has a named empty example (CR-005) and the seeded role matrix is published in the contract, generated from the IAM seed and checked in CI so it cannot drift (CR-023); no existing shape changes (built; the session split before CR-028, A-241) |
| B09x continued | `B09x2-shop-profile.md` | `b09x2-shop-profile` | B4 to B12 | The business profile is stored and changed only through AUD's audited, step-up write; getShopProfile answers anonymously and cacheably with the contact fields only, its keys listed exactly by a test; the seed uses invented, clearly fictional numbers; every write refuses the wrong role |
| B09q | `B09q-ids-barcodes.md` | `b09q-ids-barcodes` | B4 to B12 | TOTP the only QR; no product barcode, lookup or label barcode while meat pack labels stay as built; server-generated SKUs; unguessable customer and supplier public IDs; no identifier reads anything without authorisation; contract 2.0.0 with every example updated |
| B09q continued | `B09q2-no-id-is-a-key.md` | `b09q2-no-id-is-a-key` | B4 to B12 | Knowing a public ID, a SKU or a UUID reads nothing without authorisation, per operation that takes one, as an anonymous caller and as another customer; every link sent to a customer carries its own long random token (built) |
| B09e | `B09e-eggs.md` | `b09e-eggs` | B4 to B12 | Built and split (A-259 to A-262): a crate and a single egg each carry their own price on the price list while stock stays in eggs; a bought lot's cost is valued by its place in the delivery, so a crate bought at GHS 47.50 posts exactly 4,750 (ADR-0075); quantity breaks counted in the selling unit and stored in eggs; orders, the counter and online sale take a line in crates; the seeded eggs counted per egg |
| B09e continued | `B09e2-eggs-lines-lots.md` | `b09e2-eggs-lines-lots` | B4 to B12 | Goods receipts and transfers take a line in crates or eggs, converted by the server through MasterDataRefs.toBaseIn; every bought lot has a received date and sells oldest first by expiry, then by received date, wherever the server picks a lot; reorder points counted in the selling unit and stored in eggs; every write refuses the wrong role |
| B09e continued 2 | `B09e3-eggs-claims.md` | `b09e3-eggs-claims` | B4 to B12 | Built and split (A-269 to A-271): a rejected quantity carries its reason (CRACKED, BROKEN, DIRTY, SHORT, WRONG_ITEM_DELIVERED, QUALITY_REJECTED), refused without one and on nothing rejected (CR-035); breakage reasons for stock adjustments; a purchase order line defaults to the last price paid; every write refuses the wrong role |
| B09e continued 3 | `B09e4-eggs-claim.md` | `b09e4-eggs-claim` | B4 to B12 | A claim raised from a posted receipt drafts the supplier credit note from the rejected lines and their cost, never keyed by hand, linked both ways, moving no stock, on the supplier's account until settled, maker and checker apart (CR-036); every write refuses the wrong role |
| B9b | `B09b-pos-shifts-offline.md` | `b09b-pos-shifts-offline` | B4 to B12 | Split (A-273 (a)): registers, shifts, cash movements, X and Z, blind close; a shift close reconciles to the pesewa |
| B09b continued | `B09b2-pos-devices-counter.md` | `b09b2-pos-devices-counter` | B4 to B12 | Split (A-274): a device enrolled and revoked; a counter sale on the cashier's own open shift with change from cash only; no cash into or out of a till but through its open shift, whoever calls PAY (ADR-0077); a cash refund only out of an open shift; the unwitnessed drop |
| B09b continued 1b | `B09b2b-pos-force-close-held.md` | `b09b2b-pos-force-close-held` | B4 to B12 | A force close signed by a manager who is not the cashier, its variance posted when the drawer is counted; held sales re-priced on recall and lapsing at close; a mobile money or card tender at the counter as a cleared payment; the audit anchor at each sign-off |
| B09b continued 2 | `B09b3-pos-offline-sync.md` | `b09b3-pos-offline-sync` | B4 to B12 | 500 queued offline transactions sync exactly once; ADR-0027's five conflict tests; a crate and a single egg sold at the till at their own prices (CR-038) |
| B09b continued 3 | `B09b4-pos-till-pin.md` | `b09b4-pos-till-pin` | B4 to B12 | The till PIN's verifier, attempt limit and supervisor sign-out as the owner set them (CR-032) |
| B09b continued 4 | `B09b5-pos-receipts.md` | `b09b5-pos-receipts` | B4 to B12 | The receipt link by its token alone (CR-033 points 1 and 2); the business buyer's TIN on the VAT invoice; an invoice paid at the till inside the shift |
| B09c | `B09c-card-payment.md` | `b09c-card-payment` | B4 to B12 | Card payment online through the provider port with every payment edge case, no card details on our servers, and the card cases run against the real sandbox |
| B08 continued 2d | `B08c2d-customer-statements.md` | `b08c2d-customer-statements` | B4 to B12 | A customer statement for a period ties to the customer's documents and the ledger's 1200 for that customer and period, opening plus movements equal to closing to the pesewa, and is rendered after commit and archived once; every statement write refuses the wrong role |
| B09u | `B09u-units-supplier-account.md` | `b09u-units-supplier-account` | B4 to B12 | Every unit has a singular and a plural name and the seeded eggs are counted in a unit named egg, figures unchanged; a receipt line against an order line is valued by the server unless typed (CR-040); a Manager approves a supplier credit note the Owner raised and the Accountant drafted; the supplier balance (CR-042); invoice approval refuses its maker (CR-043); CR-044's descriptions; every write refuses the wrong role |
| B10 | `B10-quotations-wholesale.md` | `b10-quotations-wholesale` | B4 to B12 | Quote revisions are versioned; conversion to invoice preserves every link; a credit limit blocks with an audited override |
| B11 | `B11-fulfilment-delivery.md` | `b11-fulfilment-delivery` | B4 to B12 | A catch-weight order re-prices at pick; cash on delivery lands against the driver; the outbox guarantees the customer notification |
| B12 | `B12-capital-costing-reporting.md` | `b12-capital-costing-reporting` | B4 to B12 | A distribution matches a hand calculation on unit-days and ties exactly to the ledger |
| B09r | `B09r-reconciliation-real-files.md` | `b09r-reconciliation-real-files` | B4 to B12 | Settlements read from Paystack's Settlements API and the bank parser written against the bank's real export; every matching rule names its source file; no real file committed; runs when both files exist, before B13 at the latest |
| B13 | `B13-hardening-deploy.md` | `b13-hardening-deploy` | B13 — Hardening, smoke suite and deploy | Every non-functional target met and evidenced on the live server |

The gates come from the amended schedule in `docs/adr/0026-session-schedule-amendment.md`. Its three further assignments were **confirmed by the owner on 2026-11-13, exactly as proposed** (A-040 in `docs/ASSUMPTIONS.md`, resolved): the online store split across B7, B9a and B11; the daily exception report in B12; retention and data-subject requests in B13. The openers below build them that way.

A session takes as long as its phase takes.

---

## B2 — Foundation

Branch `b02-foundation`. Report `docs/sessions/B02-foundation.md`. Gate: one-command setup on a clean machine, CI green.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B2 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (B01's).
For the foundation, also read docs/MODULE_BOUNDARIES.md section 7 (the lint rule and the data checks),
docs/TEST_STRATEGY.md, docs/ENGINEERING_STANDARDS.md, docs/ONBOARDING.md section 4 (what pnpm setup must do),
and ADR-0001, ADR-0008, ADR-0012, ADR-0013, ADR-0024 and ADR-0025.
Do not read any other document unless this phase needs it.

Owner decision of 2026-11-13, so you need not go back through docs/ASSUMPTIONS.md: A-040 is resolved.
All three further assignments in ADR-0026 are confirmed exactly as proposed, with no changes: the online
store in B7 (catalogue, cart, checkout reservation), with order placement and online payment in B9a and
abandoned-cart messaging in B11; retention and data-subject requests in B13; the daily exception report in B12.
SA-13 is also confirmed, with a delivery split recorded in ADR-0026: zones and fees in B4, the slot table and
slot generation in B7, slot capacity and the rest of DEL in B11. The B01 report's "zone and fee only" text
about checkout is stale; ADR-0026 and docs/ASSUMPTIONS.md are current.

Confirm in three lines: the phase, its scope, and its gate.
First, because this is a fresh session, run Run 2 of docs/prompts/SKILLS_VERIFICATION.md (tasks T01 to T32,
one at a time) and record which skill loads for each.
Try once more to verify the Prism mock, bounded rather than as a long-running server: start it in the
background, wait a few seconds, curl one endpoint, then kill it. If that is refused too, say so and
leave it. The frontend verifies it in F2.
Then execute B02 only, on branch b02-foundation, including the two-session advisory-lock test that ADR-0005
and ASSUMPTIONS A-060 require: the kernel first (Money, Weight, Quantity,
Result, UUIDv7, Clock, and allocate, with the ADR-0028 tests 1, 2 and 4 named exactly as the ADR
gives them), then the workspace, typed configuration, Docker Compose, migrations runner, the error
envelope with correlation id, logging and tracing, the test harness and the four test scripts, CI,
and pnpm setup. No module code. Before claiming the gate, delete node_modules and the Docker volumes,
run pnpm setup and watch it come up, and add the CI job that does the same from a fresh checkout.
Stop at the gate and write docs/sessions/B02-foundation.md.
```

## B3 — Platform and the first vertical slice

Branch `b03-platform-slice`. Report `docs/sessions/B03-platform-slice.md`. Gate: the slice passes all four test layers and the frontend can log in against the real API.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B3 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B02-foundation.md).
For the platform, also read docs/security/SECURITY_ARCHITECTURE.md, docs/API.md, and ADR-0006, ADR-0009,
ADR-0010, ADR-0014, ADR-0016, ADR-0017, ADR-0022, ADR-0024 and ADR-0029, and the platform and iam
dictionaries in docs/data-model/. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B03 only, on branch b03-platform-slice: authentication, authorisation with the
maker-checker rule, the audit trail with its hash chain, the outbox and inbox, the ports (observability,
storage, queue, notifications, payments) with one adapter each, and then the Product create, read and
list slice through every layer with unit, integration, contract and end-to-end tests. Keep the slice
small and exemplary: every module session copies its shape. Write the exact login flow into the report,
with token lifetimes and cookie attributes, because the frontend needs it to switch off its stub.
Stop at the gate and write docs/sessions/B03-platform-slice.md.
```

## B4 — Master data and the pricing engine

Branch `b04-master-data-pricing`. Report `docs/sessions/B04-master-data-pricing.md`. Gate: a price resolves for every band, channel and customer tier in the catalogue, and an unresolvable request becomes a quote rather than an error.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B03-platform-slice.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, and ADR-0004, ADR-0020, ADR-0021
and ADR-0001. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate. Confirm that all sixteen hakorem skills are loaded.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day floor
(A-076). Copy the B3 Product slice's shape for every endpoint: domain, application with the policy engine and
idempotency, infrastructure, interface with @Operation, and the operation moved from the planned file into
openapi/<operationId>.yaml (ADR-0031).
Also build what B3 left to B4 (A-087): the file store with uploads, the malware scanner and evidence_file_id on
iam.approval_request; user and grant administration; customer registration and phone verification; password
reset; and the approval endpoints over the existing mechanism. Regenerate the seeded farm through the new MDM and
IAM services (A-085).
Then execute B04 only, on branch b04-master-data-pricing: master data (catalogue, categories, units,
species, grades, weight bands, customers, suppliers, branches, locations, payment methods, delivery
zones, reason codes), price lists in approved effective-dated versions, the pricing engine with the
fixed resolution order and the typed quote-required result, promotions and coupons, and the tax
calculator with named levies per ADR-0020 (exact tests for exclusive and inclusive prices, the
GHS 459.00 beef split into 382.50, 57.38, 9.56 and 9.56, a compounding levy, zero-rated and exempt
categories, and an incomplete scheme version that cannot be activated). Seed the farm.
Stop at the gate and write docs/sessions/B04-master-data-pricing.md.
```

## B4 continued — The rest of master data, tax, promotions and the B3 carry-overs

Branch `b04c-master-data-continued`. Report `docs/sessions/B04c-master-data-continued.md`. B4 built the pricing sub-domain and passed its gate (`docs/sessions/B04-master-data-pricing.md`); this session finishes MDM and the items B3 left. Gate: the tax calculator's exact cases pass (exclusive and inclusive prices, the GHS 459.00 beef split into 382.50, 57.38, 9.56 and 9.56, a compounding levy, zero-rated and exempt categories, an incomplete scheme version refused); promotions apply only to tier, channel and base prices and stack by their rules, and a coupon limited to 100 refuses the 101st under 20 concurrent redemptions; the A-087 operations are live, each with a wrong-role refusal; the seeded farm is written through the MDM and IAM services.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04-master-data-pricing.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, and ADR-0020, ADR-0036 and ADR-0004
(the promotions part). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if
@nestjs/platform-express 11.2.10 has passed the 14-day floor (A-076). Copy the B3 Product slice's shape
for every endpoint, with the fragment moved from the planned file (scripts/contract/move-to-code.ts).
Then execute B04 continued only, on branch b04c-master-data-continued: the A-087 items (the file store
with uploads, the malware scanner and evidence_file_id on iam.approval_request; user and grant
administration; customer registration and phone verification; password reset; approveRequest,
rejectRequest, listApprovals and getApproval over the existing mechanism); the rest of master data
(categories, species, grades, weight bands, customers and addresses, tiers, suppliers, branches,
locations, payment methods, delivery zones, reason codes, assignCustomerPriceList, updateProduct, the
price list listings); promotions and coupons in the engine after the base price; and the tax calculator
with named levies per ADR-0020 with the exact tests above. Regenerate the seeded farm, B3's slice and
B4's, through the new services (A-085), keeping src/seed/reference-pricing.ts as the price definition.
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): put the tax calculator under
src/modules/mdm/domain/tax/ and uncomment its 100 percent gate in vitest.config.mts; put the promotion
rules under src/modules/mdm/domain/pricing/, where B4's gate already covers them. Fill every branch the
gates expose; the gate does not pass on a lowered number.
Stop at the gate and write docs/sessions/B04c-master-data-continued.md.
```

## B4 continued (d) — Promotions, the rest of master data and the MDM seed

**Split on 2026-11-15 (A-103):** B04d built promotions and coupons and passed that part of the gate; the rest of master data and the MDM seed moved to "B04d continued" below, which carries the rest of this gate.

Branch `b04d-master-data-promotions`, from `b04c-master-data-continued` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04d-master-data-promotions.md`. B04 continued built the tax sub-domain and split (A-097, ADR-0026 Amendments). Gate: promotions apply only to tier, channel and base prices and stack by their rules (two in one stack group, only the larger applies; an exclusive 10 percent with a 5 percent in another group applies only the exclusive one), and a coupon limited to 100 refuses the 101st under 20 concurrent redemptions without exceeding 100; every master data write refuses the wrong role; the seeded farm's MDM data, its tax scheme version 1 included, is written through the MDM services, and `calculateTax` answers on a fresh `pnpm run setup`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04c-master-data-continued.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, and ADR-0004 (the promotions part),
ADR-0036 and ADR-0039. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day
floor (A-076). Copy the B3 Product slice's shape for every endpoint, with the fragment moved from the
planned file (scripts/contract/move-to-code.ts), and the tax slice's shape for maker-checker documents.
Then execute B04d only, on branch b04d-master-data-promotions, branched from b04c-master-data-continued:
promotions and coupons in the engine after the base price (FR-MDM-018), the promotion rules under
src/modules/mdm/domain/pricing/ where the 100 percent gate already covers them, the coupon limit held by
a row lock in the database, the discount a separate recorded adjustment on the line; the rest of master
data (categories, units of measure with CR-003's displayDecimals, species, grades, weight bands,
customers and addresses, tiers, suppliers, branches, locations, payment methods, delivery zones, reason
codes, assignCustomerPriceList, updateProduct, the price list listings); and the MDM seed through the
new services (A-085), including tax scheme version 1 with the ADR-0020 seed matrix drafted by the
seeded Accountant and approved by the seeded Owner, keeping src/seed/reference-pricing.ts as the price
definition. Imports and exports (FR-MDM-019, FR-MDM-020) need the file store, which is B04e's: build
them there or record them as deferred. Write the failing tests first for every money and permission rule.
Stop at the gate, write docs/sessions/B04d-master-data-promotions.md, push, and open a stacked pull
request against b04c-master-data-continued.
```

## B04d continued — The rest of master data and the MDM seed

Branch `b04d-continued-master-data`, from `b04d-master-data-promotions` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04d-continued-master-data.md`. B04d built promotions and coupons (FR-MDM-018, ADR-0040, contract 1.6.0) and split at that sub-domain boundary (A-103, ADR-0026 Amendments). Gate: every master data write refuses the wrong role; the seeded farm's MDM data, its tax scheme version 1 included, is written through the MDM services, and `calculateTax` answers on a fresh `pnpm run setup`. When this gate passes, B04d's gate as a whole has passed.

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

## B04d continued 2 — Parties, locations and the rest of the MDM seed

Branch `b04d2-parties-locations`, from `b04d-continued-master-data` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04d2-parties-locations.md`. B04d continued built the catalogue (categories, units with CR-003, species, grades, weight bands, `updateProduct`; contract 1.7.0) and the seed through services for the catalogue, the price lists, tax scheme version 1 and the promotions (ADR-0041), then split at that sub-domain boundary (A-108, ADR-0026 Amendments). Gate: every remaining master data write refuses the wrong role; branches, locations and customers are seeded through the MDM services, the caterer's contract list is assigned through `assignCustomerPriceList`, and no part of the MDM seed is written as SQL. When this gate passes, B04d's gate as a whole has passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04d-continued-master-data.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, ADR-0036, ADR-0040 and ADR-0041.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day
floor (A-076). Copy the catalogue slice's shape (B04d continued: CatalogueAdmin, PgCatalogueStore,
CatalogueController) for every endpoint, with the fragment moved from the planned file
(scripts/contract/move-to-code.ts).
Then execute B04d continued 2 only, on branch b04d2-parties-locations, branched from
b04d-continued-master-data: customers and addresses (FR-MDM-008, with Ghana phone normalisation), tiers,
suppliers (FR-MDM-007), branches and locations (FR-MDM-006, the parent in the same branch, enforced by the
database too), payment methods (FR-MDM-009), delivery zones and quoteDelivery (FR-MDM-010), reason codes
(FR-MDM-011, a fixed list seeded by migration), the price list listings and updates (listPriceLists,
updatePriceList, archivePriceList, listPriceListVersions, listPriceListEntries), assignCustomerPriceList
(FR-MDM-021) and archiveProduct, each write with a wrong-role refusal; and the rest of the MDM seed
through the services (A-085, ADR-0041): branches, locations and customers move from src/seed/farm-b3.ts
and src/seed/farm-b4.ts into src/seed/farm-mdm.ts, and the caterer's list is assigned through
assignCustomerPriceList, replacing the interim SQL there. Imports and exports (FR-MDM-019, FR-MDM-020)
need the file store, which is B04e's: build them there or record them as deferred. Write the failing
tests first for every money and permission rule. Stop at the gate, write
docs/sessions/B04d2-parties-locations.md, push, and open a stacked pull request against
b04d-continued-master-data.
```

## B04d continued 3 — Suppliers and the reference data

Branch `b04d3-reference-data`, from `b04d2-parties-locations` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04d3-reference-data.md`. B04d continued 2 built branches and locations, customers with their tiers and addresses, and `assignCustomerPriceList` (contract 1.8.0, ADR-0042), and moved the rest of the MDM seed onto the services, then split at that sub-domain boundary (A-114, ADR-0026 Amendments). Gate: every remaining master data write refuses the wrong role; reason codes are a fixed list seeded by migration with no write operation; `quoteDelivery` returns exactly 1,500 pesewas for an address in a zone whose fee is 1,500, and "delivery unavailable" (not zero) for an address in none; payment methods and delivery zones are seeded through the MDM services. When this gate passes, B04d's gate as a whole has passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04d2-parties-locations.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, ADR-0036, ADR-0041 and ADR-0042.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day
floor (A-076). Copy the parties and locations slice's shape (B04d continued 2: AdminKit, PartiesAdmin,
PgPartiesStore, PartiesController) for every endpoint, with the fragment moved from the planned file
(scripts/contract/move-to-code.ts).
Then execute B04d continued 3 only, on branch b04d3-reference-data, branched from
b04d2-parties-locations: suppliers (FR-MDM-007, phones normalised as customers' are), payment methods
(FR-MDM-009), delivery zones and quoteDelivery (FR-MDM-010, with the expand migration that adds
delivery_zone_id to mdm.customer_address and resolves it at save, A-112), reason codes (FR-MDM-011, a fixed
list seeded by migration), the price list listings and updates (listPriceLists, updatePriceList,
archivePriceList, listPriceListVersions, listPriceListEntries) and archiveProduct, each write with a
wrong-role refusal; and their seed through the services (A-085, ADR-0041): the payment methods and a
Dodowa delivery zone. Imports and exports (FR-MDM-019, FR-MDM-020) need the file store, which is B04e's:
build them there or record them as deferred. Write the failing tests first for every money and permission
rule (a zone fee is exact pesewas). Stop at the gate, write docs/sessions/B04d3-reference-data.md, push,
and open a stacked pull request against b04d2-parties-locations.
```

## B4 continued (e) — The B3 carry-overs in IAM

**Built, and split (A-121).** B04e built user, role-reading and grant administration and moved the IAM seed onto the services (ADR-0043); the rest moved to the two sections that follow. The opener below is kept as it was run.

Branch `b04e-iam-carry-overs`, from `b04d3-reference-data` (stacked). Report `docs/sessions/B04e-iam-carry-overs.md`. Gate: the A-087 operations are live (the file store with uploads, the malware scanner and `evidence_file_id` on `iam.approval_request`; user and grant administration; customer registration and phone verification; password reset with CR-004 point 3's error codes; `approveRequest`, `rejectRequest`, `listApprovals` and `getApproval` over the existing mechanism), each with a wrong-role refusal; the IAM seed is written through the IAM services. When this gate passes, B04 continued's gate as a whole has passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04d3-reference-data.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the IAM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/iam.md, the IAM card in docs/MODULE_BOUNDARIES.md, ADR-0017, ADR-0034, ADR-0035 and A-057
in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on every operation: they are authentication, uploads and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e only, on branch b04e-iam-carry-overs, branched from b04d3-reference-data: the
A-087 items listed in the gate, MDM's imports and exports if B04d continued 3 deferred them, and the IAM seed through
the IAM services (A-085). Write the failing tests first for every permission rule.
Stop at the gate, write docs/sessions/B04e-iam-carry-overs.md, push, and open a stacked pull request
against b04d3-reference-data.
```

## B04e continued — Roles, approvals and the customer realm

**Built** (contract 1.11.0, A-122, A-123): the whole gate, with no split. The opener below is kept as it was run.

Branch `b04e2-auth-approvals`, from `b04e-iam-carry-overs` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04e2-auth-approvals.md`. B04e built user, role-reading and grant administration (contract 1.10.0, A-120) and moved the IAM seed onto the services (ADR-0043), then split at that sub-domain boundary (A-121, ADR-0026 Amendments). Gate: `createRole` and `updateRole` (step-up, system roles not deletable), `listApprovals`, `getApproval`, `approveRequest`, `rejectRequest` and `cancelApprovalRequest` over the existing mechanism, `registerCustomer` and `verifyCustomerPhone` (FR-IAM-019: an identical answer for a known phone, a 6th wrong code refused even if correct), and `requestPasswordReset` and `resetPassword` (FR-IAM-020, with CR-004 point 3's named error codes for a wrong, used or expired token) are live, each write with a wrong-role refusal.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e-iam-carry-overs.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the IAM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/iam.md, the IAM card in docs/MODULE_BOUNDARIES.md, ADR-0017, ADR-0034, ADR-0035 and
ADR-0043. Use docs/prompts/module-build-prompt.md as the recipe, and run hakorem-security-review on every
operation: they are authentication, approvals and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Copy the user and grant slice's shape (B04e: AccessAdmin, PgAccessStore, AccessController) for every
endpoint, with the fragment moved from the planned file (scripts/contract/move-to-code.ts).
Then execute B04e continued only, on branch b04e2-auth-approvals, branched from b04e-iam-carry-overs:
role writes (createRole, updateRole), the approval endpoints over the existing Approvals mechanism
(listApprovals, getApproval, approveRequest, rejectRequest, cancelApprovalRequest), customer registration
and phone verification (FR-IAM-019), and password reset (FR-IAM-020) with CR-004 point 3's error codes.
Notification delivery is B11's: send the codes through the existing notification port and record what
waits. Write the failing tests first for every permission rule. Stop at the gate, write
docs/sessions/B04e2-auth-approvals.md, push, and open a stacked pull request against b04e-iam-carry-overs.
```

## B04e continued 2 — The file store, uploads and MDM imports

**Built in part** (contract 1.12.0, ADR-0044, A-124): the file store, the scanner and `evidence_file_id`. The session split at the boundary between the file store and its consumers (A-125); product images and the imports and exports are B04e continued 3's. The opener below is kept as it was run.

Branch `b04e3-file-store-imports`, from `b04e2-auth-approvals` (stacked). Report `docs/sessions/B04e3-file-store-imports.md`. Gate: `uploadFile`, `getFile` and `createFileSignedUrl` are live on the platform file store (size cap before the body is read, type by content sniffing, a random key, scan status `PENDING` until the malware scanner (A-057) says `CLEAN`, signed expiring URLs logged), `iam.approval_request.evidence_file_id` exists with its foreign key, product images attach through it, and MDM's imports and exports (FR-MDM-019, FR-MDM-020) run with a dry-run preview, each write with a wrong-role refusal. When this gate passes, B04e's and B04 continued's gates as a whole have passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e2-auth-approvals.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM and DOC requirement blocks' file and import requirements in docs/SRS.md
(FR-MDM-019, FR-MDM-020 and the DOC upload requirements, nothing else), docs/data-model/iam.md,
docs/data-model/mdm.md, the platform and MDM cards in docs/MODULE_BOUNDARIES.md, ADR-0025, ADR-0032 and
A-057 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on every operation: they are uploads, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 2 only, on branch b04e3-file-store-imports, branched from b04e2-auth-approvals:
the file store with uploadFile, getFile and createFileSignedUrl, the malware scanner (A-057),
evidence_file_id on iam.approval_request, product images, and MDM's imports and exports with a dry run.
Write the failing tests first for every permission rule. Stop at the gate, write
docs/sessions/B04e3-file-store-imports.md, push, and open a stacked pull request against b04e2-auth-approvals.
```

## B04e continued 3 — Product images and MDM imports and exports

**Built in part** (contract 1.13.0, ADR-0045, A-126): product photographs, their public variants and the gallery operations. The session split at the boundary between the photographs and the spreadsheet imports and exports (A-127); the imports and exports are B04e continued 4's. The opener below is kept as it was run.

Branch `b04e4-product-images-imports`, from `b04e3-file-store-imports` (stacked). Report `docs/sessions/B04e4-product-images-imports.md`. B04e continued 2 built the file store (contract 1.12.0, ADR-0044, A-124): `uploadFile`, `getFile` and `createFileSignedUrl` in the DOC module over the platform `FileStore`, the ClamAV scan in the worker, and `evidence_file_id`, then split at the boundary between the file store and its consumers (A-125, ADR-0026 Amendments). Gate: `addProductImage` (and the other product image operations the contract plans) attaches a CLEAN `PRODUCT_IMAGE` file through `mdm.product_image`, re-encoded into variants at 320, 640 and 1280 pixels (WebP with a JPEG fallback) in `platform.stored_file_variant`, none above 200 KB at 640 pixels for a 4 MB JPEG, the original never served publicly (FR-DOC-005); and MDM's imports and exports (FR-MDM-019, FR-MDM-020: `listImportJobs`, `createImportJob`, `getImportJob`, `listImportErrors`, `applyImportJob`, `cancelImportJob`, `createExportJob`) run with a dry run that writes nothing, apply all or none, and audit exports with their row count, step-up above the bulk threshold and a signed expiring link, each write with a wrong-role refusal. When this gate passes, B04e's and B04 continued's gates as a whole have passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e3-file-store-imports.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-MDM-019, FR-MDM-020, FR-DOC-005 and SEC-009 in docs/SRS.md (nothing else),
docs/data-model/mdm.md (product images, import jobs and their errors), docs/data-model/platform.md
(the file store tables), the platform, MDM and DOC cards in docs/MODULE_BOUNDARIES.md, ADR-0041, ADR-0044
and A-124 and A-125 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on every operation: they are uploads, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 3 only, on branch b04e4-product-images-imports, branched from
b04e3-file-store-imports: product images through the file store with their variants (an image library
needs an ADR), and MDM's imports and exports with a dry run (a spreadsheet library needs an ADR). Reuse
the platform FileStore and the DOC upload; do not add a second upload path. Write the failing tests first
for every permission rule. Stop at the gate, write docs/sessions/B04e4-product-images-imports.md, push,
and open a stacked pull request against b04e3-file-store-imports.
```

## B04e continued 4 — MDM imports and exports

**Built in part** (contract 1.14.0, ADR-0046, A-128): the import and export mechanism (the spreadsheet codec, the seven operations, the job rules in the database) with the customer sheet, and that part of the gate passed. The session split at the boundary between the mechanism and the remaining sheets (A-129); those are B04e continued 5's, and opening stock is B5's. The opener below is kept as it was run.

Branch `b04e5-mdm-imports-exports`, from `b04e4-product-images-imports` (stacked). Report `docs/sessions/B04e5-mdm-imports-exports.md`. B04e continued 3 built product photographs (contract 1.13.0, ADR-0045, A-126): the worker's variants in `platform.stored_file_variant`, `addProductImage` and `removeProductImage` over `mdm.product_image`, then split at the boundary between the photographs and the spreadsheet imports (A-127, ADR-0026 Amendments). Gate: MDM's imports and exports (FR-MDM-019, FR-MDM-020: `listImportJobs`, `createImportJob`, `getImportJob`, `listImportErrors`, `applyImportJob`, `cancelImportJob`, `createExportJob`) run over an `IMPORT` file from the file store with a dry run that writes nothing, apply all or none in one transaction, and audit exports with their row count, step-up above the bulk threshold (SEC-009) and a signed expiring link, each write with a wrong-role refusal. `OPENING_STOCK` writes stock, which INV owns and B5 builds: decide with an assumption whether its dry run and apply wait for B5. When this gate passes, B04e's and B04 continued's gates as a whole have passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e4-product-images-imports.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-MDM-019, FR-MDM-020 and SEC-009 in docs/SRS.md (nothing else), docs/data-model/mdm.md
(import jobs and their errors, and the tables of the entities an import writes), docs/data-model/platform.md
(the file store tables), the platform, MDM and DOC cards in docs/MODULE_BOUNDARIES.md, ADR-0041, ADR-0044,
ADR-0045 and A-124 to A-127 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and
run hakorem-security-review on every operation: they are uploads, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 4 only, on branch b04e5-mdm-imports-exports, branched from
b04e4-product-images-imports: MDM's imports and exports with a dry run (a spreadsheet library needs an ADR),
reading the IMPORT file through the platform FileStore; do not add a second upload path. Write the failing
tests first for every permission rule. Stop at the gate, write docs/sessions/B04e5-mdm-imports-exports.md,
push, and open a stacked pull request against b04e4-product-images-imports.
```

## B04e continued 5 — The remaining MDM import sheets

**Built** (contract 1.15.0, A-130): the product, supplier, location and price list entry sheets, and the gate passed. With it B04e's and B04 continued's gates as a whole have passed. The opener below is kept as it was run.

Branch `b04e6-mdm-import-sheets`, from `b04e5-mdm-imports-exports` (stacked). Report `docs/sessions/B04e6-mdm-import-sheets.md`. B04e continued 4 built the import and export mechanism (contract 1.14.0, ADR-0046, A-128): `src/platform/spreadsheet/` (XLSX and CSV on Node's zlib, no dependency), `MdmImports` with the seven operations over `mdm.import_job` (HK009), and one `EntitySheet`, `CustomerSheet`, which applies rows through `PartiesAdmin.createCustomerIn` and `updateCustomerIn`; then it split at the boundary between the mechanism and the remaining sheets (A-129, ADR-0026 Amendments). Gate: the `PRODUCT`, `SUPPLIER`, `LOCATION` and `PRICE_LIST_ENTRY` sheets each import with a dry run that writes nothing and apply all rows or none through the entity's own service in the import's transaction (an `...In` method like `createCustomerIn`), and export audited with their row count and a fresh step-up, each with a wrong-role refusal and its own row-error tests; `AVAILABLE_ENTITIES` then lists every entity but `OPENING_STOCK`, which stays 422 `IMPORT_ENTITY_NOT_AVAILABLE` until B5. When this gate passes, B04e's and B04 continued's gates as a whole have passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e5-mdm-imports-exports.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-MDM-019 and FR-MDM-020 in docs/SRS.md and the requirements of the entities a sheet
writes (FR-MDM-001 products, the supplier, location and price list entry requirements; nothing else),
docs/data-model/mdm.md (import jobs and the tables of products, suppliers, locations and price list entries),
the MDM card in docs/MODULE_BOUNDARIES.md, ADR-0046 and A-128 and A-129 in docs/ASSUMPTIONS.md. Use
docs/prompts/module-build-prompt.md as the recipe, and run hakorem-security-review on every sheet: they are
imports, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 5 only, on branch b04e6-mdm-import-sheets, branched from
b04e5-mdm-imports-exports: one EntitySheet each for products, suppliers, locations and price list entries
(price list entries into a draft version, never an active one), each writing through the entity's own
service in the import's transaction. Reuse MdmImports and the platform spreadsheet codec; do not add a
dependency. Write the failing tests first for every permission rule and every price. Stop at the gate,
write docs/sessions/B04e6-mdm-import-sheets.md, push, and open a stacked pull request against
b04e5-mdm-imports-exports.
```

## B5 — Inventory and the stock movement ledger

**Built in part; the session split** (A-131, ADR-0026 Amendments): the movement ledger and every database invariant, valuation under its 100 percent gate, `Stock.postIn`, `Lineage` and `BalanceReconciliation`, contract unchanged at 1.15.0. The rest is B05 continued, below. The opener is kept as it was run.

Branch `b05-inventory-ledger`. Report `docs/sessions/B05-inventory-ledger.md`. Gate: on-hand derived from movements matches a hand count, stock cannot go negative outside the allowed movement types, and a lot traces in both directions. B5 also builds the `OPENING_STOCK` import sheet, deferred from B04e continued 4 (A-128).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e6-mdm-import-sheets.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, and ADR-0002, ADR-0005,
ADR-0018, ADR-0019 and ADR-0027 (the stock exception part). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 only, on branch b05-inventory-ledger: the append-only movement ledger with the balance
trigger, movement types and reason codes, locations and virtual locations, stock units and lineage,
cost pools with specific identification and weighted average, reservations and holds, goods receipts,
transfers, adjustments with approval, stock take, stock exceptions, and the tests ADR-0002 requires,
each rejection path as its own integration test (negative stock, double sale of a serial unit, sale
under hold, update and delete refused). Extend the seed with stock. Build the OPENING_STOCK import sheet
too (A-128): MDM sits below INV, so the sheet is INV's, registered with MdmImports through a port MDM
defines and INV implements (like ProductUsageCheck; a new port needs an ADR), posting OPENING_BALANCE
movements in the import's transaction; read ADR-0046 for the mechanism.
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): put stock valuation under
src/modules/inv/domain/valuation/ and uncomment its 100 percent gate in vitest.config.mts before the
gate passes. Fill every branch it exposes; the gate does not pass on a lowered number.
Stop at the gate and write docs/sessions/B05-inventory-ledger.md.
```

## B05 continued — Stock documents, the INV endpoints, opening stock and the seed

**Built in part; the session split** (A-138, ADR-0026 Amendments): goods receipts (migration 0047, permissions 0048 and 0049, six operations), stock on hand at cost, a stock unit and the trace over HTTP, CR-001 and CR-003 point 2 (contract 1.16.0), and the seed with stock through the services; the hand count of the seeded farm and the two-way trace over the API pass. The rest is B05 continued 2, below. The opener is kept as it was run.

Branch `b05b-inventory-documents`, from `b05-inventory-ledger` (stacked). Report `docs/sessions/B05b-inventory-documents.md`. B5 built the ledger core (A-131): migrations 0042 to 0046, schema `inv` with every stock invariant in the triggers of 0044 (SQLSTATE HK010, the rule as the constraint name), MDM's published functions `location_stock_facts` and `product_tracking` (ADR-0047), `src/modules/inv/domain/valuation/` under its gate, `Stock.postIn` (serializable only; refusals arrive as `INSUFFICIENT_STOCK`, `STOCK_UNIT_NOT_AVAILABLE`, `STOCK_UNIT_ON_HOLD`, `STOCK_UNIT_RESERVED`, `STOCK_MOVEMENT_ALREADY_REVERSED`; the ADR-0003 posting event through the outbox), `Lineage.linkIn` and `trace`, and `BalanceReconciliation.run` (raises `BALANCE_DRIFT`, corrects nothing; not yet scheduled). Gate: the B5 gate in full: on-hand derived from movements matches a hand count of the seeded farm, stock cannot go negative outside the allowed movement types, and a lot traces in both directions over the API, with every INV write refusing the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05-inventory-ledger.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0018,
ADR-0019, ADR-0027 (the stock exception part), ADR-0046 and ADR-0047, A-128 and A-131 to A-134 in
docs/ASSUMPTIONS.md, and migration 0044. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on adjustments, write-offs and the opening stock import.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued only, on branch b05b-inventory-documents, branched from b05-inventory-ledger:
goods receipts, transfers with in-transit and receipt variance, adjustments with approval at the
threshold (maker and checker differ), stock takes with blind counts and cycle counts that refuse
overlapping scopes, the hold, reservation and exception services with the reservation expiry job,
temperature readings with automatic quarantine, reorder and expiry alerts (and the refusal to sell an
expired lot), the scheduling of the nightly recompute, and the INV endpoints of the contract with their
permissions, each write with a wrong-role refusal; answer CR-001 and CR-003 point 2 on the stock lines.
Post every movement through Stock.postIn; never write a projection. Build the OPENING_STOCK import sheet
(A-128): the sheet is INV's, registered with MdmImports through a port MDM defines and INV implements
(a new port needs an ADR), posting OPENING_BALANCE movements in the import's transaction. Extend the seed
with stock through the services. Keep the valuation gate at 100 percent. Stop at the gate and write
docs/sessions/B05b-inventory-documents.md.
```

## B05 continued 2 — Transfers, adjustments, stock takes, holds, cold chain, alerts and opening stock

**Built in part; the session split** (A-140, ADR-0026 Amendments): the movement reads and their reversal with approval, transfers through in-transit with receipt variance, and adjustments with approval at the threshold (migrations 0050 to 0053, 15 operations, contract 1.17.0). The rest is B05 continued 3 and B05 continued 4, below. The opener is kept as it was run.

Branch `b05c-inventory-control`, from `b05b-inventory-documents` (stacked). Report `docs/sessions/B05c-inventory-control.md`. B05 continued built goods receipts (migration 0047: `inv.goods_receipt`, its lines and `inv.goods_receipt_animal`, frozen once posted; `GoodsReceipts.createIn` and `postIn` posting through `Stock.postIn`), stock on hand at cost with each line's exact share of its pool (`domain/valuation/pool-lines.ts`, under the 100 percent gate), `getStockUnit`, `traceStockUnit`, MDM's `MasterDataRefs`, `Authoriser.scopes` for narrowing lists to a reader's grants, the permissions `inv.stock.read` and `inv.goods_receipt.*` (A-135), contract 1.16.0, and the seed with stock (`src/seed/farm-inv.ts`, its hand count in `SEED_HAND_COUNT`). Gate: the B5 gate in full: on-hand derived from movements matches a hand count of the seeded farm, stock cannot go negative outside the allowed movement types, and a lot traces in both directions over the API, with every INV write refusing the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05b-inventory-documents.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0017,
ADR-0018, ADR-0019, ADR-0027 (the stock exception part), ADR-0046 and ADR-0047, A-128, A-131 to A-138
in docs/ASSUMPTIONS.md, and migrations 0044 and 0047. Use docs/prompts/module-build-prompt.md as the
recipe, and run hakorem-security-review on adjustments, write-offs and the opening stock import.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 2 only, on branch b05c-inventory-control, branched from b05b-inventory-documents:
transfers with in-transit and receipt variance, adjustments with approval at the threshold (maker and
checker differ), stock takes with blind counts and cycle counts that refuse overlapping scopes, the hold,
reservation and exception services with the reservation expiry job, temperature readings with automatic
quarantine, reorder and expiry alerts (and the refusal to sell an expired lot), the scheduling of the
nightly recompute, and the remaining INV endpoints of the contract (movements and their reversal, stock
units and their movements, availability, holds, reservations, exceptions, transfers, adjustments, stock
takes, reorder rules, alerts, temperature readings) with their permissions, each write with a wrong-role
refusal. Post every movement through Stock.postIn; never write a projection. Build the OPENING_STOCK
import sheet (A-128): the sheet is INV's, registered with MdmImports through a port MDM defines and INV
implements (a new port needs an ADR), posting OPENING_BALANCE movements in the import's transaction; then
decide whether a goods receipt of kind OPENING stays refused (A-136). Extend the seed through the services
where these documents need it. Keep the valuation gate at 100 percent. Run the B5 gate in full, stop at
it and write docs/sessions/B05c-inventory-control.md.
```

## B05 continued 3 — Stock takes, holds, reservations and exceptions

Branch `b05d-inventory-counts-holds`, from `b05c-inventory-control` (stacked). Report `docs/sessions/B05d-inventory-counts-holds.md`. B05 continued 2 built movements and their reversal (`StockMovements`, `inv.stock_reversal`, approval kind `STOCK_REVERSAL`), transfers (`StockTransfers`, through the branch's `IN_TRANSIT` location, a shortfall as `ADJUST_LOSS` with a `TRANSFER_VARIANCE` exception) and adjustments (`StockAdjustments`, approval kind `STOCK_WRITE_OFF`, the threshold copied onto the document from `Approvals.judgeIn`), with the shared command and view helpers in `application/stock-command.ts`, the line rules in `domain/stock-documents.ts`, `valueAtAverage` under the valuation gate, migrations 0050 to 0053 and contract 1.17.0 (A-139). Gate: a stock take posts a gain or loss per variance from blind counts and its variance value at or above the threshold waits for approval; a cycle count of an overlapping scope is refused; a hold blocks a sale until released by a named user with a reason, and a withdrawal hold cannot be released; an expired reservation is released by the job; every write refuses the wrong role.

**Split (A-143):** this session built stock takes, cycle counts and holds and passed that part of the gate. Reservations, the expiry job, exceptions, availability and the stock unit list moved to B05 continued 3b below.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05c-inventory-control.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0017,
ADR-0018, ADR-0019, ADR-0027 (the stock exception part) and ADR-0047, A-131 to A-140 in
docs/ASSUMPTIONS.md, migrations 0044 and 0051, and src/modules/inv/application/stock-adjustments.ts as the
pattern for a document with approval. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on stock-take variance posting, hold release and exception resolution.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 3 only, on branch b05d-inventory-counts-holds, branched from b05c-inventory-control:
stock takes (createStockTake through submitStockTake, listStockTakes, getStockTake, listStockTakeLines,
cancelStockTake) with expected figures frozen at start and hidden from the counter, recounts, a variance
report, STOCKTAKE_GAIN and STOCKTAKE_LOSS movements, and approval of a variance value at or above the
threshold (STOCK_WRITE_OFF, maker and checker differ); cycle counts that refuse overlapping scopes; the
hold service (listStockHolds, createStockHold for QUARANTINE and INVESTIGATION, releaseStockHold with a
named user and a reason, a WITHDRAWAL hold never released early) and the in-process Holds interface LIV
will call; the reservation service (listStockReservations, releaseStockReservation, the Reservations
interface with serializable reserve) and the scheduled reservation expiry job publishing
inv.ReservationExpired; the exception service (listStockExceptions, getStockException,
resolveStockException posting any correction through the adjustment path); listStockAvailability and
listStockUnits. Each write with a wrong-role refusal. Post every movement through Stock.postIn; never
write a projection. Keep the valuation gate at 100 percent. Stop at the gate and write
docs/sessions/B05d-inventory-counts-holds.md.
```

## B05 continued 3b — Reservations, exceptions, availability and the stock unit list

Branch `b05d2-inventory-reservations-exceptions`, from `main` (each phase is merged into `main` when green, ADR-0026 Amendments). Report `docs/sessions/B05d2-inventory-reservations-exceptions.md`. B05 continued 3 built stock takes and cycle counts (`StockTakes`, migration 0054, the `STOCK_WRITE_OFF` approval shared with adjustments through `StockWriteOffs`) and holds (`StockHolds` with `placeIn`, migration 0057), with permissions in 0055, 0056, 0058 and 0059 and contract 1.18.0 (A-141, A-142). Gate: one active reservation per animal and reserved never above available, proved under concurrency; an expired reservation is released by the scheduled job exactly as reserved and `inv.ReservationExpired` is published through the outbox; a stock exception is resolved once with a resolution kind and note, any correction posted through the adjustment path; availability is on hand less reserved less held; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05d-inventory-counts-holds.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0010,
ADR-0017, ADR-0019, ADR-0027 (the stock exception part), ADR-0047 and ADR-0048, A-131 to A-143 in
docs/ASSUMPTIONS.md, migrations 0044 and 0057, and src/modules/inv/application/stock-holds.ts and
stock-adjustments.ts as the patterns. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on reservation release and exception resolution.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 3b only, on branch b05d2-inventory-reservations-exceptions, branched from
main: the reservation service (listStockReservations, releaseStockReservation,
the Reservations interface with serializable reserve and consume, one active reservation per animal,
reserved never above available, proved under concurrency) and the scheduled reservation expiry job
releasing exactly what it reserved and publishing inv.ReservationExpired through the outbox; the
exception service (listStockExceptions, getStockException, resolveStockException with a resolution kind
and note, posting any correction through the adjustment path and its approval); ADR-0048 (owner, 2026-11-15):
receiveStockTransfer stops posting a shortfall as a loss and holds it instead (never sellable, reservable or
transferable; the hand count still reconciles), and resolveStockException clears a TRANSFER_VARIANCE either
by writing it off under the adjustment threshold and step-up (202 ApprovalPending above it, maker never the
checker, threshold copied onto the document) or by recording the goods as found, each test-first; listStockAvailability
(on hand less reserved less held) and listStockUnits. Each write with a wrong-role refusal. Post every
movement through Stock.postIn; never write a projection. Keep the valuation gate and the stock-take and
hold domain gates at 100 percent. Stop at the gate and write
docs/sessions/B05d2-inventory-reservations-exceptions.md.
```

## B05 continued 4 — Cold chain, alerts, opening stock and the B5 gate

Branch `b05e-inventory-cold-chain-opening`, from `main` (each phase is merged into `main` when green, ADR-0026 Amendments). Report `docs/sessions/B05e-inventory-cold-chain-opening.md`. Gate: the B5 gate in full: on-hand derived from movements matches a hand count of the seeded farm, stock cannot go negative outside the allowed movement types, and a lot traces in both directions over the API, with every INV write refusing the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05d2-inventory-reservations-exceptions.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0017,
ADR-0018, ADR-0019, ADR-0046, ADR-0047, ADR-0048 and ADR-0049, A-128 and A-131 to the latest INV assumption in
docs/ASSUMPTIONS.md, and migrations 0044 and 0047. Use docs/prompts/module-build-prompt.md as the
recipe, and run hakorem-security-review on the opening stock import and temperature quarantine.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 4 only, on branch b05e-inventory-cold-chain-opening, branched from
main: temperature readings (listTemperatureReadings, recordTemperatureReading)
with automatic quarantine of every lot in the location in the reading's transaction, a
TEMPERATURE_EXCURSION exception and an event (a location's range is MDM's: read it through MDM's
interface, and a database rule that needs it needs a new proposed ADR, since ADR-0047 is not widened
silently); reorder rules (listReorderRules, createReorderRule, updateReorderRule) and listStockAlerts with
one low-stock alert per crossing; expiry alerts by a daily job and the refusal to sell an expired lot
(A-134 (j)); the scheduling of the nightly recompute (BalanceReconciliation) and the expiry alerts as ScheduledJob entries in
src/worker-app.ts (ADR-0049, as reservation-expiry is); the OPENING_STOCK import
sheet (A-128): the sheet is INV's, registered with MdmImports through a port MDM defines and INV
implements (a new port needs an ADR), posting OPENING_BALANCE movements in the import's transaction;
then decide whether a goods receipt of kind OPENING stays refused (A-136). Each write with a wrong-role
refusal. Post every movement through Stock.postIn; never write a projection. Extend the seed through the
services where these need it. Keep the valuation gate at 100 percent. Run the B5 gate in full, with a
walk that every INV write operation refuses the wrong role, stop at it and write
docs/sessions/B05e-inventory-cold-chain-opening.md.
```

## B05x — Dashboard tiles, branch management and label data, pulled forward for the frontend

Branch `b05x-dashboard-branches-labels`, from `main` (each phase is merged into `main` when green, ADR-0026 Amendments). Report `docs/sessions/B05x-dashboard-branches-labels.md`. Inserted by the owner on 2026-11-15 between B5 and B6: the frontend's UI phase needs these endpoints earlier than B12 schedules them. Everything is additive. Gate: getOwnerDashboard answers in one request with its sourceless figures null and listed with their reasons and phases; every tile whose data exists answers from the real API, and in getOwnerDashboard, with exact values on the seeded farm (stock value at cost equal to `listStockOnHand`'s total, the animal count equal to a hand count of serialised live stock units, the low stock count equal to the products at or below their reorder point, the purchases series equal to posted goods receipts at cost per day); the tiles whose data does not exist yet are in the contract, live only on the mock, and named in the openers that will build them; a branch can be deactivated, with its refusals, and branches and locations list only within the caller's grants; label data for a lot and a product answers from the real API; every operation refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is reasonable, record in the report
what you declined and why, never edit that file and never open frontend source.
For this phase, read the RPT and MDM (branches and locations) requirement blocks of docs/SRS.md and NFR-023
(nothing else from the SRS), the RPT, MDM and INV cards in docs/MODULE_BOUNDARIES.md, ADR-0011 (published
views), ADR-0023 (the reporting read model), ADR-0026 (Amendments), ADR-0042 and ADR-0047, and the planned
contract's getOwnerDashboard and printPackLabels. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05x only, on branch b05x-dashboard-branches-labels, branched from main:
1. Dashboard in RPT, reading only published views (ADR-0011, ADR-0023), scoped to the branches the caller
   holds rpt permissions at, money as integer pesewas, with asOf. Build getOwnerDashboard now (owner,
   2026-11-15: NFR-023 from the start, one call for the frontend to wire, never rewired): it composes the
   figures below, and its response carries a required list naming each figure that has no source yet and
   why (figure, reason, and the phase that makes it live), each such figure null exactly while it is
   listed. B8, B9a and B9b empty that list field by field with no contract change. Making those planned
   OwnerDashboard fields nullable is a change to a published (never implemented) shape: a LOUD changelog
   entry and a line at the top of the cold-read summary. If the contract versioning check calls it breaking,
   do not weaken the check and do not bump the major version: leave getOwnerDashboard out, finish the rest,
   and report the conflict. B12 keeps the caching and the performance budget. Also one operation per tile,
   for tiles embedded on other screens: stock value at cost, animals on hand (serialised live stock units
   on hand, by species), low stock count (products at or below their reorder point, from B05 continued 4's
   published view), and a purchases time series over a period (posted goods receipts at cost, per day in
   Africa/Accra), all live now; today's sales, cash position, outstanding receivables and a sales time
   series in the contract only (mock), never answered from code before their source exists, since a 200
   with a zero is a placeholder. Add a line to the B8, B9a and B9b openers naming the dashboard figures and
   tiles each must make live.
2. Branch and location management where B04d continued 2 left gaps: deactivate (and reactivate) a branch
   with its refusals (not the last active branch, not one holding stock or open documents, not the
   farm's own), and listBranches and listLocations scoped to the caller's grants. Kasoa and KNUST are real
   selling points the owner will create through the API: do not seed them as SEED data.
3. Label data for printing lot and product barcodes, if the contract does not expose it: a read that
   returns what a label prints (code, name, lot, weight, dates, the barcode payload and its symbology),
   no image rendering. printPackLabels stays B6's.
Each operation with a wrong-role refusal, written test-first; update the cold-read summary at the top of
docs/CONTRACT_CHANGELOG.md with every contract change. Record the schedule change in ADR-0026
Amendments.
Stop at the gate, write docs/sessions/B05x-dashboard-branches-labels.md, and merge into main when every
run on the pull request is green.
```

## B6 — Livestock and processing

Branch `b06-livestock-processing`, from `main` (ADR-0026 Amendments). Report `docs/sessions/B06-livestock-processing.md`. Gate: a processing order consumes an animal and produces lots whose costs sum exactly to the input cost plus the direct processing cost.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05x-dashboard-branches-labels.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the LIV and PRC requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/liv.md and docs/data-model/prc.md, the LIV and PRC cards in docs/MODULE_BOUNDARIES.md,
and ADR-0018 and ADR-0019. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06 only, on branch b06-livestock-processing, branched from main: the animal register, batches, weights and
growth, health events with veterinary withdrawal holds that nobody can release early, breeding,
mortality and culls with photograph and second approver above the threshold, rations and feed with
head-days allocation, processing orders with yield against standard and variance flag, relative-sales-value
cost allocation by largest remainder, packs and labels (printPackLabels, whose barcodes follow B05x's
LabelBarcode: CODE_128, A-151; an animal's weights carry their source, which getStockUnitLabel then shows). Write the allocation test first: outputs'
allocated costs sum exactly to input cost plus direct cost, including an awkward split. Extend the seed.
Stop at the gate and write docs/sessions/B06-livestock-processing.md.
```

## B06m — The master data contract requests CR-009 to CR-011

Branch `b06m-master-data-requests`, from `main`. Report `docs/sessions/B06m-master-data-requests.md`. Inserted on 2026-11-15 (A-155): every master data phase had finished, so three frontend requests about master data were declined by each later phase as "not this phase" and had no owner. Small and additive. Gate: `previewPriceListVersion` answers cursor pages comparing a draft with the version in force, by the pricing engine's own entry identity (product, grade, band, quantity break), each line `ADDED`, `CHANGED`, `REMOVED` or `UNCHANGED` with `counts`, exact on a seeded list with one of each, refusing the wrong role; the price list examples agree with one another and show a change; CR-011 is answered in the contract and the report.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), CR-009, CR-010
and CR-011 above all: implement what is reasonable, record in the report what you declined and why, never
edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (units of measure and price lists only;
nothing else from the SRS), docs/data-model/mdm.md (units, price lists and their entries), the MDM card in
docs/MODULE_BOUNDARIES.md, ADR-0004 and ADR-0036. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06m only, on branch b06m-master-data-requests, branched from main:
1. CR-009: previewPriceListVersion (GET /price-list-versions/{id}/preview, mdm.price_list.read, at the
   version's branch), comparing the version with the one in force at its validFrom by the same identity the
   engine resolves on, in cursor pages of at most 100 with counts for the four kinds and the version
   compared against. Read-only; test-first, including a version with nothing in force (every line ADDED).
2. CR-010: make the price list examples agree (getPriceList.activeVersion the ACTIVE version 4, the draft
   version 5 with one changed price), so the mock shows a preview with a change.
3. CR-011: answer it. Say in the contract whether units are seeded only, and how a conversion is held
   today (a crate of 30 eggs, a pack's nominal kilograms), from what the data model actually has. If the
   brief's "units of measure with conversions" is not built, do not build a new subsystem here: record it
   honestly in docs/BACKLOG.md or as an assumption naming the phase that owns it, and say so in the report.
Every contract change goes in docs/CONTRACT_CHANGELOG.md and the cold-read summary at its top; examples in
farm terms. Stop at the gate, write docs/sessions/B06m-master-data-requests.md, and merge into main when
every run on the pull request is green.
```

## B06 continued — Livestock management, packs and labels

Branch `b06b-livestock-packs`, from `main` (ADR-0026 Amendments). Report `docs/sessions/B06b-livestock-packs.md`. Gate: every LIV write refuses the wrong role; a withdrawal hold blocks sale and processing and nobody releases it early; mortality at or above the threshold waits for a photograph and a different approver; feed and veterinary cost spread by head-days sum exactly to the value issued; pack weights equal the lot weight and a pack label encodes the lot and the weight.

**Built and split on 2026-11-15 (A-158):** this phase built the livestock core and passed the gate for it; animal edits, growth, batches and breeding are B06 continued 2's, and packs, labels and the reversing order B06 continued 3's (below).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06m-master-data-requests.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the LIV block and FR-PRC-009 to FR-PRC-011 of docs/SRS.md (nothing else from the SRS),
docs/data-model/liv.md and docs/data-model/prc.md, the LIV and PRC cards in docs/MODULE_BOUNDARIES.md,
and ADR-0018 and ADR-0019. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06 continued only, on branch b06b-livestock-packs, branched from main: the animal register (an animal
record per serialised stock unit, opened from inv.StockUnitRegistered), batches, weights with their source and growth,
health events with veterinary withdrawal holds placed through INV's StockHolds.placeIn that nobody can release early,
breeding and births, mortality and culls with photograph and second approver at or above the threshold (maker never
the checker, threat model abuse case 2), rations and feed with head-days allocation through the kernel's allocate,
the animal's status kept in step with its stock unit (a goat consumed by a B6 processing order becomes SLAUGHTERED),
then PRC's packs and labels (createPacks, listPacks, printPackLabels, whose barcodes follow B05x's LabelBarcode:
CODE_128, A-151) and the reversing order of FR-PRC-011. Decide the Farm hand's PRC access (A-153). Write the money,
weight and permission tests first. Extend the seed. If this does not fit one context, split at the LIV and PRC
boundary as B6 did. Stop at the gate and write docs/sessions/B06b-livestock-packs.md.
```

## B06 continued 2 — Animal edits, growth, batches and breeding

Branch `b06c-livestock-growth-breeding`, from `main` (ADR-0026 Amendments). Report `docs/sessions/B06c-livestock-growth-breeding.md`. Inserted on 2026-11-15 when B06 continued split at a LIV sub-domain boundary (A-158). Gate: every remaining LIV write refuses the wrong role; a move starts only where the animal is and changes no cost; average daily gain and feed conversion match a hand calculation (FR-LIV-005, FR-LIV-016); a batch closes only when empty or with a documented reason; a birth registers each live offspring at nil cost linked to its dam, and refuses a dam that was not alive and female; the feed, medicine, store and ration seed is counted by hand in the B5 and B05x hand counts.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06b-livestock-packs.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-LIV-002, FR-LIV-003, FR-LIV-005, FR-LIV-006, FR-LIV-010, FR-LIV-011 and FR-LIV-016 of
docs/SRS.md (nothing else from the SRS), docs/data-model/liv.md, the LIV card in docs/MODULE_BOUNDARIES.md, and
ADR-0018. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase
needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06 continued 2 only, on branch b06c-livestock-growth-breeding, branched from main, on top of the
livestock core B06 continued built (src/modules/liv): updateAnimal (purpose decides capitalised or expensed; fixed
attributes refused), moveAnimal (a TRANSFER_INTERNAL movement through INV's Stock.postIn from where the animal is),
listAnimalTimeline, listGrowth (average daily gain per animal, pen and batch over animals present for the whole
window, feed conversion from the feed issued, mortality percent), the batches (liv.batch, a flock's lot as its stock
unit, with an expand migration adding liv.animal.batch_id; a batch's purpose then decides a flock's cost treatment
instead of A-158's GROWING default), and breeding and births (liv.breeding_record, gestation days from data, recordBirth
registering offspring through INV at nil cost with a BIRTH movement and lineage to the dam, and the expand migration
adding liv.animal.breeding_record_id). Extend the seed with feed and medicine products, the Dodowa store, their stock
and rations, and count them by hand into the B5 and B05x hand counts. Write the money, weight and permission tests
first. Stop at the gate and write docs/sessions/B06c-livestock-growth-breeding.md.
```

## B06 continued 3 — Packs, labels and the reversing order

Branch `b06d-packs-labels`, from `main` (ADR-0026 Amendments). Report `docs/sessions/B06d-packs-labels.md`. Inserted on 2026-11-15 with B06 continued 2 (A-158). Gate: first, a Farm hand sees the animal register, rations and health events with their withdrawal holds and never a cost, on every LIV and PRC operation the role can reach (owner, 2026-11-15); then pack weights equal the lot weight and a pack label encodes the lot and the weight; a completed processing order is frozen and reverses only while its outputs are unsold, restoring the animal to its pen at its prior cost; every pack write refuses the wrong role; the Farm hand's PRC access is decided (A-153).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06c-livestock-growth-breeding.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PRC-009 to FR-PRC-011 of docs/SRS.md (nothing else from the SRS), docs/data-model/prc.md,
the PRC card in docs/MODULE_BOUNDARIES.md, and ADR-0018, and A-153, A-158 and A-159 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
First, before packs (owner, 2026-11-15, replacing A-158's Farm hand line): the Farm hand reads what animal
work and food safety need, the animal register, feed rations and above all health events with their withdrawal
holds, so a treated animal is never sent to slaughter or sale; and never a cost. Use the codebase's pattern for
cost visibility if there is one; otherwise give that role cost-free read shapes (a separate response shape
without the cost fields), never nullable cost fields. Main today leaks cost to the role: B06 continued 2 granted
liv.animal.update, liv.animal.move, liv.batch.read, liv.batch.create and liv.batch.update (migration 0082), whose
answers carry cost, so close those first. Death records and anything only about money stay refused. Tests,
written first: a Farm hand reads a treated goat's withdrawal hold and its end; and one test that walks every
LIV and PRC route the role's grants reach and asserts no response schema, example or live response carries a
cost or pesewa field. Record the matrix in the assumption that holds it (A-158) as the owner's decision.
Then execute B06 continued 3 only, on branch b06d-packs-labels, branched from main: PRC's packs and labels (prc.pack;
createPacks, listPacks, printPackLabels, whose barcodes follow B05x's LabelBarcode: CODE_128, A-151; the payload
<lot>/<grams, six digits>), the reversing order of FR-PRC-011 (cancelProcessingOrder on a COMPLETED order, reversing
its movements through INV's StockMovements only while every output is unsold; the reversed animal is ALIVE again, which
LIV's register already follows), and the Farm hand's PRC access (A-153). Write the weight and permission tests first.
Extend the seed. Stop at the gate and write docs/sessions/B06d-packs-labels.md.
```

## B06u — Units of measure and their conversions

Branch `b06u-uom-conversions`, from `main`. Report `docs/sessions/B06u-uom-conversions.md`. Inserted by the owner on 2026-11-15 (A-157): FR-MDM-003's alternative units were never built, and they belong before anything sells by a unit other than a product's base unit, not inside B9a. Small and additive. Gate: a product's alternative units convert to its base unit by an exact numerator and denominator, FR-MDM-003's unit test passes, a conversion that is not exact is refused by the database, the conversions list answers in the contract, and every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), CR-011 above all:
implement what is reasonable, record in the report what you declined and why, never edit that file and never
open frontend source.
For this phase, read FR-MDM-003 of docs/SRS.md (nothing else from the SRS), the units and product_uom_conversion
parts of docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md and A-157. Use
docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money and hakorem-stock: a conversion changes a
quantity, and a quantity times a price is money.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06u only, on branch b06u-uom-conversions, branched from main: mdm.product_uom_conversion with
numerator and denominator and the exact-factor rule in the database, FR-MDM-003's unit test, the operations to
list (CR-011's listUomConversions or conversions on Uom, whichever the contract can carry additively) and to
manage a product's conversions with wrong-role refusals, read by other modules through MasterDataRefs. A catch-
weight line is charged by the weighed kilograms, so a pack-to-kilogram factor is never a conversion (A-157).
Write the conversion and permission tests first; examples in farm terms; changelog and cold-read summary.
Stop at the gate, write docs/sessions/B06u-uom-conversions.md, and merge into main when every run on the pull
request is green.
```

## B7 — Procurement and suppliers, and the storefront cart

Branch `b07-procurement-suppliers`. Report `docs/sessions/B07-procurement-suppliers.md`. Gate: three-way match blocks payment where receipt and supplier invoice disagree, and checkout reserves stock and releases it on timeout.

**Built on 2026-11-15 as purchase to pay, and split (A-165, ADR-0026 Amendments):** the rest of procurement is **B07 continued** and the storefront is **B07 continued 2**, both below.

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

## B07 continued — The supplier register and the rest of procurement

Branch `b07b-supplier-register`, from `main`. Report `docs/sessions/B07b-supplier-register.md`. Inserted by the B7 split (A-165, ADR-0026 Amendments). Gate: a payout detail change returns 202 and the old details stay in force until a different person approves, with the stored column ciphertext; a document whose content is not what its name says is refused; a rejected requisition cannot be converted and a converted one links its order; a credit note cannot exceed the invoice's uncredited amount; the supplier score matches FR-PUR-014's hand calculation; every write refuses the wrong role.

**Built on 2026-11-15 as the supplier register and requisitions, and split (A-167, ADR-0026 Amendments):** credit notes, the approved variance, the remittance data and supplier scores are **B07 continued 1b**, below.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07-procurement-suppliers.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PUR requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pur.md
(its "As built in B7" note first), the PUR card in docs/MODULE_BOUNDARIES.md, ADR-0020, ADR-0022 and ADR-0044, and
A-164 and A-165 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money,
hakorem-security-review (payout details, documents, approvals) and hakorem-migration.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued only, on branch b07b-supplier-register, branched from main: supplier profiles with
payment terms (and invoice due dates from them), categories supplied and payout details encrypted (ADR-0022),
decrypted only with a permission and audited, changed only through a SUPPLIER_PAYOUT_CHANGE approval by a different
person (FR-PUR-001, FR-PUR-002); supplier documents through the file store (FR-PUR-003); requisitions and their
conversion to a purchase order (FR-PUR-004); supplier credit notes against an invoice's uncredited amount, with a
supplier-return movement through INV where goods go back (FR-PUR-011); the approved variance that lets a mismatched
invoice be paid (FR-PUR-010); the data of the remittance advice (FR-PUR-013; rendering waits for B8); supplier
scores (FR-PUR-014). Write the permission, money and approval tests first; extend the seed; changelog and cold-read
summary for every contract change. Stop at the gate, write docs/sessions/B07b-supplier-register.md, and merge into
main when every run on the pull request is green.
```

## B07 continued 1b — Credit notes, the approved variance, remittance data and supplier scores

Branch `b07b2-supplier-credit-scores`, from `main`. Report `docs/sessions/B07b2-supplier-credit-scores.md`. Inserted by the B07 continued split (A-167, ADR-0026 Amendments). Gate: a credit note cannot exceed the invoice's uncredited amount (a credit of 11,000 against a 110,000 invoice leaves 99,000 payable; a second credit of 100,000 is refused), in the handler and the database, with a supplier-return movement through INV where goods go back; an approved variance lets a mismatched invoice be paid, and never by its maker; a paid payment's remittance data lists its invoices, amounts and reference once; the supplier score matches FR-PUR-014's hand calculation (91.0); every write refuses the wrong role.

**Built on 2026-11-15** (A-172 to A-174): credit notes with the supplier-return movement, the approved variance, the remittance data and supplier scores, contract 1.30.0. B06r follows.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07b-supplier-register.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PUR-010, FR-PUR-011, FR-PUR-013 and FR-PUR-014 in the PUR block of docs/SRS.md (nothing else
from the SRS), docs/data-model/pur.md (its "As built" notes first), the PUR and INV cards in docs/MODULE_BOUNDARIES.md,
ADR-0017, ADR-0020, ADR-0043 and A-164, A-166 to A-171 in docs/ASSUMPTIONS.md (A-168 to A-171 are the owner's
decisions of 2026-11-15: keep the cross-approval of payout changes and the bar on their maker approving the first
payment after them). Use docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money, hakorem-stock (the supplier
return), hakorem-security-review (the variance approval) and hakorem-migration.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued 1b only, on branch b07b2-supplier-credit-scores, branched from main: supplier credit notes
(createSupplierInvoice with kind CREDIT_NOTE) against an invoice's uncredited amount, held by the database, reducing
what is payable, with a supplier-return movement through INV's published interface where goods go back and the
ledger event for B8 (FR-PUR-011); the approved variance that lets a mismatched invoice be paid, approved by a different
person (FR-PUR-010); the data of the remittance advice for a paid payment, answered once per payment (FR-PUR-013;
rendering waits for B8); supplier scores from receipts, rejections, lead times and invoice prices with the weights 30,
25, 25 and 20 held as settings (FR-PUR-014). Write the money, permission and approval tests first; extend the seed;
changelog and cold-read summary for every contract change. Stop at the gate, write
docs/sessions/B07b2-supplier-credit-scores.md, and merge into main when every run on the pull request is green.
```

## B06r — The processing reversal and the farm hand's death reports under approval (A-162, F6)

Branch `b06r-processing-reversal-approval`, from `main`. Report `docs/sessions/B06r-processing-reversal-approval.md`. Inserted by the owner on 2026-11-15, answering A-162 and the frontend's F6: reversing a completed processing order moves stock value back, so it follows the transfer write-off pattern of ADR-0048; and a farm hand's death report must be completable by the farm hand as maker, with a person above them confirming every write-off. Small. Gate: a farm hand finds an animal by its exact tag with no cost field; a farm hand reports a death, uploads its photograph (EVIDENCE) and submits it, and a manager approves it, whatever its value (below the direct write-off threshold a supervisor confirms; at or above it the existing second approver with step-up), the farm hand never writing stock off alone; uploads are EVIDENCE only for the role; approval waits for a CLEAN photograph and a rejected one returns the report to its maker; a reused photograph is flagged for the exception report; and a reversal at or above the adjustment threshold waits for a second approver with step-up and the maker is refused as checker; below it the maker's reason is required and the reversal reaches the exception report's sources; a reversal is refused outright, by the domain and the database, once any pack it produced has been sold or moved; the threshold is copied onto the reversal document; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PRC-011 of docs/SRS.md (nothing else from the SRS), docs/data-model/prc.md (the reversal),
ADR-0048 (the pattern to copy), A-139, A-153 and A-162 in docs/ASSUMPTIONS.md, and src/modules/inv/application/
stock-exceptions.ts and stock-adjustments.ts as the approval pattern. Load hakorem-stock, hakorem-money and
hakorem-security-review. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Also, before the reversal (owner, 2026-11-15, the frontend's F6 and CR-021):
- CR-021: a cost-free exact tag lookup for the Farm hand (ADR-0052), for example getCareAnimalByTag or an exact
  `tagNo` filter on listCareAnimals, documented as exact, refusing the wrong role.
- Death reports: the farm hand is the maker; they report, upload the photograph and submit, and a manager
  approves. Today the role holds no platform.file.upload, so a report at or above the threshold dead-ends. A farm
  hand may upload EVIDENCE files and nothing else: if the file store cannot restrict upload by purpose, build that
  check (in the application layer, deny by default, with a test that a farm hand's PRODUCT_IMAGE or any other
  purpose is refused) rather than falling back to a broader grant. Below the direct write-off threshold a farm hand must
  not write stock off alone: their submission waits for a supervisor's confirmation (a role that may post a
  write-off) instead of posting at once; other makers keep the direct write-off below the threshold. Maker is
  never the checker. Test-first, including the full farm hand path and a refusal for each wrong role.
- Scan state: a death report may be submitted while its photograph is still PENDING, so nobody waits at the pen;
  approval is refused until the file is CLEAN; if the scan rejects the file (infected or unscannable), the report
  goes back to its maker with a reason. Test all three.
- Reused photographs: every stored file already has its sha256 (migration 0033). If an EVIDENCE photograph with
  the same sha256 is attached to a second death report, it goes on the exception report: build the detection as
  an LIV published view (ADR-0011) or event the daily exception report (B12) reads, with a test, and a line in
  B12's opener. A byte hash catches the same file twice, not a re-saved or cropped copy: say so, and park
  perceptual matching in docs/BACKLOG.md. State it in the contract too: uploadFile's EVIDENCE description and the
  death report operations say that the client should open the camera directly for death evidence (the owner's
  frontend rule, 2026-11-15) as a deterrent, that the server cannot tell a camera photo from a gallery one, and
  that a reused photograph is matched by exact bytes only.
- Record the role matrix change in A-158 as the owner's decision.
Then execute B06r only, on branch b06r-processing-reversal-approval, branched from main: cancelling a COMPLETED
processing order (A-162 as built: Owner and Manager, its own reversal document, refused once an output is sold)
now follows ADR-0048. At or above the adjustment threshold (copied onto the document, never read live) it
answers 202 ApprovalPending and posts only on a different approver's approval with step-up; below it, a reason
is required and the reversal is recorded where the daily exception report (B12) will read it, through a
published view or event, with a line added to B12's opener. Refuse it outright, in the domain and in the
database, once any pack or output it produced has been sold or moved, because putting the carcass back would
hide the stock that left. Each rule test-first, including a mutation check that the database refusal stands
on its own. Stop at the gate, write docs/sessions/B06r-processing-reversal-approval.md, and merge into main when
every run on the pull request is green.
```

## B07 continued 2 — The storefront catalogue, cart and checkout reservation

Branch `b07c-storefront-checkout`, from `main`. Report `docs/sessions/B07c-storefront-checkout.md`. Inserted by the B7 split (A-165, ADR-0026 Amendments). Gate: the shared sort mechanism (CR-019) pages without skipping or repeating a row through ties and concurrent inserts; the second half of B7's: checkout reserves stock and releases it on timeout. Also: a live animal (`REQUEST_TO_BUY`) cannot be added to a cart; the catalogue carries no cost; `del.delivery_slot` exists with slot generation and checkout stores a chosen slot through its foreign key; every staff write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06r-processing-reversal-approval.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the SHP requirement block of docs/SRS.md and FR-DEL-001 (nothing else from the SRS),
docs/data-model/shp.md and del.md, the SHP and DEL cards in docs/MODULE_BOUNDARIES.md, and ADR-0011, ADR-0019,
ADR-0020, ADR-0021, ADR-0026 (the online-store assignment and the delivery split) and SA-13 in docs/ASSUMPTIONS.md.
Use docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money, hakorem-stock, hakorem-pricing and
hakorem-security-review (the public cart and checkout).
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued 2 only, on branch b07c-storefront-checkout, branched from main: the public catalogue
and product page with availability levels and no cost (FR-SHP-001, FR-SHP-002), the cart with server-computed totals
and prices re-resolved by MDM's PricingService, coupons through Promotions (FR-SHP-003, FR-SHP-004), and checkout
reservation through INV's Reservations only (serializable, all lines or none, the 15-minute release by the expiry
job releasing exactly what it reserved, FR-SHP-005, FR-SHP-006), the catch-weight estimate and maximum (FR-SHP-007),
the zone fee (FR-SHP-008), and, as the ADR-0026 delivery split decides, the del.delivery_slot table and slot
generation, with checkout storing a chosen slot through its foreign key but not enforcing capacity (capacity and
cut-offs are B11). A live animal cannot be added to a cart (422 REQUEST_TO_BUY_ONLY). A cart line in a unit other
than the product's base unit converts through MasterDataRefs.toBaseIn, never with a factor of its own. Order
placement and online payment are B09a. Write the reservation, money and permission tests first; extend the seed.
CR-019, server-side sort (owner, 2026-11-15): build the shared sort mechanism once, here, because the
storefront catalogue needs sorting by price and name anyway: an allow-list of sort fields per list (any other
field is 400), each backed by an index, and the cursor carrying the sort key and the id as a tie-breaker, so
pages never skip or repeat a row even when values tie or rows arrive between pages (prove it with a test that
pages through ties and concurrent inserts). Apply it to the storefront catalogue, then to the console lists of
products, stock on hand, lots and movements. If those four console lists make the phase too big, put them in a
small phase right after this one, still before B8, and say so.
Stop at the gate, write docs/sessions/B07c-storefront-checkout.md, and merge into main when every run on the pull
request is green.
```

## B07 continued 3 — Server-side sort on the console lists (CR-019)

Branch `b07c3-console-sort`, from `main`. Report `docs/sessions/B07c3-console-sort.md`. Inserted by the B07 continued 2 split (A-179, ADR-0026 Amendments). Gate: `listProducts`, `listStockOnHand`, `listStockUnits` and `listStockMovements` take CR-019's `sort` and `direction` through the shared keyset (ADR-0054), each allowed field backed by an index, any other field 400 `SORT_NOT_ALLOWED`; each list pages without skipping or repeating a row through ties and rows inserted between pages, proved per list; each operation's example shows its default order; every read still refuses the wrong role and the Farm hand still sees no cost.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07c-storefront-checkout.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read CR-019 in that file, ADR-0054, docs/API.md section 5 and the as-built notes of
docs/data-model/mdm.md and inv.md for the four lists' tables (nothing else from the SRS). Use
docs/prompts/module-build-prompt.md as the recipe. Load hakorem-endpoint, hakorem-migration and hakorem-tests.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued 3 only, on branch b07c3-console-sort, branched from main: apply the shared sort of
src/platform/http/keyset-sort.ts (ADR-0054, built and proved in B07 continued 2) to the console lists of products,
stock on hand, lots and movements, with CR-019's fields (listProducts: name, sku, category, status, updatedAt;
listStockOnHand: product name, location name, onHandQty, valueAtCostPesewas; listStockUnits: product name,
identifier, expiresOn, valueAtCostPesewas; listStockMovements: occurredAt, product name, valuePesewas), `sort` and
`direction` query parameters, an index per allowed field in each module's own migration (a field whose value is
computed, such as a value at cost or another module's name, is sorted only if it can be indexed honestly in the
owning schema: otherwise decline that field in the report with the reason), and each list's default order unchanged
and shown in its example. A cost field stays readable only with its cost permission (ADR-0052): sorting by it is
refused to a role that cannot read it. Write a test per list that pages through ties and concurrent inserts.
Stop at the gate, write docs/sessions/B07c3-console-sort.md, and merge into main when every run on the pull
request is green.
```

## B8 — General ledger, billing and document generation

Branch `b08-ledger-billing`. Report `docs/sessions/B08-ledger-billing.md`. **Built and passed; the session split after its gate (A-187): the remainder is B08 continued and B08 continued 2 below.** Gate: the trial balance sums to zero on a seeded trading day, an unbalanced journal is rejected by the database itself, and numbering stays gap-free under concurrent load.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07c3-console-sort.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN, BIL and DOC requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/fin.md, bil.md and doc.md, the FIN, BIL and DOC cards in docs/MODULE_BOUNDARIES.md,
and ADR-0001, ADR-0003, ADR-0005, ADR-0015 and ADR-0020. Read the accountant's answers on A-020, A-024
to A-029, A-033 and A-034 in docs/ASSUMPTIONS.md: if they are still open, proceed on the stated
assumptions, record that in the report, and make each answerable as data. Use
docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 only, on branch b08-ledger-billing: the chart of accounts and posting rules as data,
journals with the deferred balance trigger and period lock, subscribers for every event marked as
posting to the ledger (with the boot assertion for a missing subscriber and the nightly reconciliation),
billing documents with levy lines, gap-free numbering, document rendering and archive with the reprint
marker, financial statements. Include the test that adds a fourth levy as data only, and the test that
every row of the ADR-0003 matrix posts exact debit and credit amounts. Regenerate the seed so every
seeded movement has its journal. End the report with B09a's opening message (ADR-0026 verification).
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): uncomment the 100 percent gate for
src/modules/fin/domain/ in vitest.config.mts before the gate passes. Fill every branch it exposes;
the gate does not pass on a lowered number.
Make the owner dashboard's B8 figures live (B05x, A-149): remove `cash`, `receivablesOutstandingPesewas` and
`receivablesOverduePesewas` from RPT's PENDING_FIGURES (src/modules/rpt/domain/dashboard.ts) and answer them from
the ledger (accounts 1000 to 1130, account 1200) and billing's due dates through published views, and build the
planned tiles getCashPositionTile and getReceivablesTile, each test-first with its wrong-role refusal.
Post PUR's waiting events (pur.SupplierInvoiceMatched, pur.ExpenseInvoiceApproved, pur.SupplierPaymentMade, A-164) and
add, by an expand migration, pur.supplier_payment.bank_account_id and remittance_document_id with their foreign keys
(docs/DATA_MODEL.md, Migrations), lifting PUR's BANK_ACCOUNT_NOT_AVAILABLE refusal.
Stop at the gate and write docs/sessions/B08-ledger-billing.md.
```

## B08 continued — The ledger's interface, periods, manual journals and the statements

Branch `b08c-ledger-interface`. Report `docs/sessions/B08c-ledger-interface.md`. **Built; the session split after its chart and periods (A-189): the remainder is B08 continued 1b and B08 continued 1c below.** Gate as built: an entry written inside a savepoint keeps its own lines and `SET CONSTRAINTS ALL IMMEDIATE` only makes the balance check earlier; every chart and period operation refuses the wrong role and the Owner approving their own period reopen; a period locks, closes and then refuses postings, proved through the API. (Planned gate, now spread over the three sessions: every FIN write refuses the wrong role (and a maker approving their own manual journal, posting rule change or period reopen); a period locks, closes and then refuses postings, proved through the API; the trial balance, profit and loss, balance sheet and cash flow tie to each other on the seeded trading day to the pesewa; a depreciation run spreads the depreciable amount exactly and posts once per period.)

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08-ledger-billing.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0003, ADR-0005, ADR-0017, ADR-0022 and ADR-0056, and the accountant's
answers on A-024 to A-029 and A-182 to A-187 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued only, on branch b08c-ledger-interface, building on the ledger core B8 merged (do not
rewrite it): FIN's planned operations in contract/openapi.yaml, each test-first with its wrong-role refusal: the chart
of accounts (FR-FIN-001, FR-FIN-002), bank accounts with encrypted numbers and step-up (`fin.bank_account`), periods with
lock, close and reopen (FR-FIN-009, FR-FIN-010, `PERIOD_REOPEN`), journals read only, manual journals with a different
approver and step-up (FR-FIN-008, the opening balance journal), posting rule and determination changes through
`POSTING_RULE_CHANGE`, the trial balance, profit and loss, balance sheet and cash flow for any range (FR-FIN-011 to
FR-FIN-013), the period balance projection, fixed assets and depreciation (FR-FIN-014, FR-FIN-015), and FIN's ◆ events
(`fin.ManualJournalApproved`, `fin.DepreciationRun`, `fin.YearClosed`) with their matrix rows and exact-amount tests.
List PERIOD_NOT_OPEN, POSTING_RULE_MISSING and SUBLEDGER_REQUIRED in the x-error-codes of every operation that posts
(A-187). Add, by an expand migration, pur.supplier_payment.bank_account_id and remittance_document_id with their
foreign keys (docs/DATA_MODEL.md, Migrations), lift PUR's BANK_ACCOUNT_NOT_AVAILABLE refusal and carry the bank account
on pur.SupplierPaymentMade so FIN posts it to its own subledger party (A-185).
Make the owner dashboard's cash figure live (B05x, A-149): remove `cash` from RPT's PENDING_FIGURES
(src/modules/rpt/domain/dashboard.ts) and answer it from the ledger (accounts 1000 to 1130) through a published view,
and build the planned tile getCashPositionTile, test-first with its wrong-role refusal.
If the phase does not fit, split at a sub-domain boundary (for example fixed assets and depreciation) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c-ledger-interface.md.
```

## B08 continued 1b — Journals, manual journals, posting rule changes and bank accounts

Branch `b08c1b-journals-rules-banks`. Report `docs/sessions/B08c1b-journals-rules-banks.md`. **Built; the session split before its bank accounts (A-192): the remainder is B08 continued 1b2 below.** Gate as built: every journal, manual journal, posting rule and determination operation refuses the wrong role, and a maker approving their own manual journal or posting rule change is refused; a manual journal posts nothing until a different person approves it with step-up, then exactly one balanced entry with its exact amounts, and `fin.ManualJournalApproved` has its matrix row and exact-amount test. (Planned gate: every journal, manual journal, posting rule, determination and bank account operation refuses the wrong role, and a maker approving their own manual journal or posting rule change is refused; a manual journal posts nothing until a different person approves it with step-up, then exactly one balanced entry with its exact amounts, and `fin.ManualJournalApproved` has its matrix row and exact-amount test; a bank account's number is stored encrypted and shown only as its last four digits; a supplier payment naming a bank account posts to that account's own subledger party.)

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c-ledger-interface.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0003, ADR-0005, ADR-0017, ADR-0022 and ADR-0056, and the accountant's
answers on A-024 to A-029 and A-182 to A-189 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1b only, on branch b08c1b-journals-rules-banks from main, building on the ledger core and the
chart and periods already merged (do not rewrite them): FIN's planned operations in contract/openapi.yaml, each
test-first with its wrong-role refusal: journals read only (listJournalEntries, getJournalEntry, listAccountActivity);
manual journals with a different approver and step-up (FR-FIN-008, kind MANUAL_JOURNAL, the opening balance journal
against 3900, A-005, OPENING_ALREADY_POSTED), with `fin.ManualJournalApproved` added to fin.posting_event_type with its
matrix row and an exact-amount test; posting rule and determination changes through `POSTING_RULE_CHANGE` with step-up
(listPostingEventTypes, listPostingRules, createPostingRule, listAccountDeterminations, createAccountDetermination),
keeping the boot assertion whole; bank accounts with encrypted numbers and step-up (`fin.bank_account`, ADR-0022).
Add, by an expand migration, pur.supplier_payment.bank_account_id and remittance_document_id with their foreign keys
(docs/DATA_MODEL.md, Migrations), lift PUR's BANK_ACCOUNT_NOT_AVAILABLE refusal and carry the bank account on
pur.SupplierPaymentMade so FIN posts it to its own subledger party (A-185).
If the phase does not fit, split at a sub-domain boundary (for example bank accounts) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c1b-journals-rules-banks.md.
```

## B08 continued 1b2 — Bank accounts and the supplier payment's bank account

Branch `b08c1b2-bank-accounts`. Report `docs/sessions/B08c1b2-bank-accounts.md`. **Built (ADR-0057, A-193, A-194): the number is sealed with a data key of its own; both writes need step-up.** Gate: every bank account operation (listBankAccounts, createBankAccount, updateBankAccount) refuses the wrong role; a bank account's number is stored encrypted and shown only as its last four digits, and adding one needs step-up; a supplier payment naming a bank account posts to that account's own subledger party, and one naming none still posts as A-185 says.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1b-journals-rules-banks.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
docs/data-model/pur.md (supplier_payment), the FIN and PUR cards in docs/MODULE_BOUNDARIES.md, ADR-0003, ADR-0017,
ADR-0022 and ADR-0056, and the accountant's answers on A-182 to A-192 in docs/ASSUMPTIONS.md (if still open, proceed on
them). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1b2 only, on branch b08c1b2-bank-accounts from main, building on what is merged (do not
rewrite it): FIN's bank account operations in contract/openapi.yaml (listBankAccounts, createBankAccount with step-up,
updateBankAccount), each test-first with its wrong-role refusal, on `fin.bank_account` with the number encrypted
(ADR-0022: decide first, by ADR or assumption, which key seals a number that belongs to no data subject) and shown only
as its last four digits; the account's GL account (1100 for a bank, 1110 for a wallet) and its own BANK_ACCOUNT subledger
party. Add, by an expand migration, pur.supplier_payment.bank_account_id with its foreign key (docs/DATA_MODEL.md,
Migrations; remittance_document_id waits for doc.archived_document in B08 continued 2, A-192), lift PUR's
BANK_ACCOUNT_NOT_AVAILABLE (a bank account of the payment's method, active; optional, so no client breaks) and carry the
bank account on pur.SupplierPaymentMade so FIN posts it to its own subledger party (A-185), with its exact-amount test.
If the phase does not fit, follow "If a session cannot finish".
Stop at the gate and write docs/sessions/B08c1b2-bank-accounts.md.
```

## B08 continued 1c — The statements, period balances, year close, fixed assets and depreciation

**Built and split on 2026-11-16 (A-198, ADR-0026 Amendments):** the statements, period balances, year close and cash figure were built; fixed assets and depreciation moved to B08 continued 1c2 below.

Branch `b08c1c-statements-assets`. Report `docs/sessions/B08c1c-statements-assets.md`. Gate: the trial balance, profit and loss, balance sheet and cash flow tie to each other on the seeded trading day to the pesewa, each read refusing the wrong role; year close leaves 3200 at zero and 3100 increased by the year's profit, with `fin.YearClosed`'s exact-amount test; a depreciation run spreads the depreciable amount exactly and posts once per period, with `fin.DepreciationRun`'s exact-amount test; every fixed asset write refuses the wrong role; the owner dashboard's cash figure answers from the ledger.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1b2-bank-accounts.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0001, ADR-0003, ADR-0005 and ADR-0056, and the accountant's answers on
A-024 to A-029 and A-182 to A-194 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1c only, on branch b08c1c-statements-assets from main, building on what is merged (do not
rewrite it): FIN's planned operations in contract/openapi.yaml, each test-first with its wrong-role refusal: the trial
balance, profit and loss, balance sheet and cash flow for any range (FR-FIN-011 to FR-FIN-013), the period balance
projection (`fin.period_balance`, computed at lock and refreshed nightly), year close moving current year earnings to
retained earnings (FR-FIN-010, `fin.YearClosed`), fixed assets and depreciation runs (FR-FIN-014, FR-FIN-015,
`fin.DepreciationRun`, `allocate` so the schedule sums exactly), each ◆ event with its matrix row and exact-amount test.
Coverage: the 100 percent gate on src/modules/fin/domain/ holds for every new rule.
Make the owner dashboard's cash figure live (B05x, A-149): remove `cash` from RPT's PENDING_FIGURES
(src/modules/rpt/domain/dashboard.ts) and answer it from the ledger (accounts 1000 to 1130) through a published view,
and build the planned tile getCashPositionTile, test-first with its wrong-role refusal.
If the phase does not fit, split at a sub-domain boundary (for example fixed assets and depreciation) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c1c-statements-assets.md.
```

## B08 continued 1c2 — Fixed assets and depreciation

**Built on 2026-11-16 (ADR-0059, A-199):** the register, disposal with `fin.FixedAssetDisposed`, depreciation runs with `fin.DepreciationRun`, and the seeded assets; no split.

Branch `b08c1c2-fixed-assets`. Report `docs/sessions/B08c1c2-fixed-assets.md`. Gate: a depreciation run spreads the depreciable amount exactly with `allocate` (FR-FIN-015's 1,200,000 over 120 months at 10,000, and 1,000,001 over 3 months at 333,334, 333,334 and 333,333) and posts once per period, a second run for the same period refused by a database unique key and proved with concurrent runs, with `fin.DepreciationRun`'s exact-amount test; a run posts only once a different person approves it; every fixed asset write refuses the wrong role; disposal posts its exact gain or loss; the four statements still tie on the seeded trading day with the seeded assets.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1c-statements-assets.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0001, ADR-0003, ADR-0005, ADR-0056 and ADR-0058, and the accountant's
answers on A-024 to A-029 and A-182 to A-198 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1c2 only, on branch b08c1c2-fixed-assets from main, building on what is merged (do not
rewrite it): FIN's planned fixed asset and depreciation operations in contract/openapi.yaml, each test-first with its
wrong-role refusal: the fixed asset register (FR-FIN-014: listFixedAssets, createFixedAsset, getFixedAsset,
updateFixedAsset, disposeFixedAsset, with disposal posting its gain or loss) and depreciation runs (FR-FIN-015:
listDepreciationRuns, createDepreciationRun, getDepreciationRun, postDepreciationRun, maker and checker never the same
user), the ◆ event `fin.DepreciationRun` (Dr 6500, Cr 1590) with its fin.posting_event_type row, rules and exact-amount
matrix test; `allocate` so each asset's schedule sums exactly to cost less residual, leftover pesewas in the final
months; one run per period held by a database unique key and proved with concurrent runs. Decide first, as an ADR or
an assumption, how an asset's cost reaches 1510 to 1540 (the asset register records; it does not itself post) and
whether disposal is its own ◆ event. Coverage: the 100 percent gate on src/modules/fin/domain/ holds for every new rule.
Extend the seed through the services with the farm's assets (a delivery vehicle, the cold room, pen housing,
equipment), and prove the four statements still tie on the seeded trading day.
If the phase does not fit, split at a sub-domain boundary (for example disposal) and follow "If a session cannot
finish".
Stop at the gate and write docs/sessions/B08c1c2-fixed-assets.md.
```

## B08 continued 2 — Billing documents, document rendering and the archive

Branch `b08c2-billing-documents`. Report `docs/sessions/B08c2-billing-documents.md`. **Built; the session split before rendering and the archive (A-201): the remainder is B08 continued 2b below.** Gate: an invoice, credit note and debit note post exact levy lines through the ledger and a fourth levy added as data only produces four levy lines and four subledger postings; billing numbers stay gap-free under concurrent issue; a reprint is byte-identical apart from its reprint marker and the archive's hash holds; the trial balance still sums to zero on the seeded trading day.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1c2-fixed-assets.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the BIL and DOC requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/bil.md and doc.md, the BIL and DOC cards in docs/MODULE_BOUNDARIES.md, and ADR-0001, ADR-0015,
ADR-0020 and ADR-0056. Read the accountant's answers on A-020, A-033 and A-034 in docs/ASSUMPTIONS.md: if they are
still open, proceed on the stated assumptions, record that in the report, and make each answerable as data.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 2 only, on branch b08c2-billing-documents: billing documents (proforma, invoice, credit
note, debit note, receipt) with levy lines from MDM's tax calculator, numbered through platform.allocate_number in
the issuing transaction, and their ◆ events (bil.InvoiceIssued, bil.CreditNoteIssued, bil.DebitNoteIssued) added to
fin.posting_event_type with their rules and an exact-amount matrix test for each row; the test that adds a fourth levy
as data only; document templates, rendering (HTML to PDF and ESC/POS), the immutable archive with its content hash, and
reprint with the reprint marker; customer statements; DOC's rendering of the supplier remittance advice from
pur.SupplierRemittanceReady (FR-PUR-013). Extend the seed through the services so the seeded trading day carries billing
documents, and prove the trial balance still sums to zero on it.
Make the owner dashboard's receivables figures live (B05x, A-149): remove `receivablesOutstandingPesewas` and
`receivablesOverduePesewas` from RPT's PENDING_FIGURES and answer them from the ledger (account 1200) and billing's due
dates through published views, and build the planned tile getReceivablesTile, test-first with its wrong-role refusal.
If the phase does not fit, split at a sub-domain boundary (for example rendering and the archive) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c2-billing-documents.md. End the report with B09a's opening message
(ADR-0026 verification).
```

## B08 continued 2b — Document rendering, the archive, reprints and statements

Branch `b08c2b-documents-archive`. Report `docs/sessions/B08c2b-documents-archive.md`. **Built; the session split before statements (A-203): the remainder is B08 continued 2c below.** Gate: every issued document of the seeded trading day is rendered after commit and archived exactly once with the SHA-256 of its stored bytes, the archive refusing change by trigger; a reprint returns the archived bytes with its reprint marker, byte-identical apart from the marker, with copy numbers 1 and 2 and no new number; a template version keeps issued documents unchanged and a template with a script or remote include is refused at save; every DOC and reprint write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c2-billing-documents.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the BIL and DOC requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/bil.md and doc.md, the BIL and DOC cards in docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0012,
ADR-0015 and ADR-0060. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 2b only, on branch b08c2b-documents-archive: document templates and their versions
(listDocumentTemplates, getDocumentTemplate, listTemplateVersions, createTemplateVersion, getTemplateVersion,
activateTemplateVersion, previewTemplateVersion; sandboxed, no script and no remote include), rendering after commit
through the outbox in the worker (HTML to PDF for A4, ESC/POS for thermal), the immutable archive doc.archived_document
with its SHA-256 and render job (listArchivedDocuments, getArchivedDocument, downloadArchivedDocument by signed URL),
bil.billing_document.archived_document_id (an expand migration) and content_hash set once by DOC, reprint with its
marker and bil.reprint_log (reprintBillingDocument, listBillingDocumentReprints, sendBillingDocument through the outbox),
the nightly numbering audit's hash and orphan check (FR-BIL-003), customer statements (listStatements, createStatement,
getStatement, sendStatement) and DOC's rendering of the supplier remittance advice from pur.SupplierRemittanceReady
(FR-PUR-013). Render and archive the seeded trading day's billing documents, and prove every one is archived once.
If the phase does not fit, split at a sub-domain boundary (for example statements) and follow "If a session cannot
finish".
Stop at the gate and write docs/sessions/B08c2b-documents-archive.md. End the report with B09a's opening message
(ADR-0026 verification).
```

## B08 continued 2c — Customer statements, the remittance advice, the template preview and sends

Branch `b08c2c-statements-remittance`. Report `docs/sessions/B08c2c-statements-remittance.md`. **Built; the session split before statements (A-206): the remainder is B08 continued 2d below. `sendBillingDocument` and `sendStatement` move to B11, where NTF delivers them (ADR-0062).** Gate as planned: a customer statement for a period lists the customer's issued documents and their settlement, ties to the ledger's 1200 for that customer and period, and is rendered after commit and archived once; a supplier remittance advice is rendered from `pur.SupplierRemittanceReady` and archived once, linked from the payment; a template preview renders without archiving or numbering anything; every statement and send write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c2b-documents-archive.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the BIL and DOC requirement blocks of docs/SRS.md and FR-PUR-013 (nothing else from the SRS),
docs/data-model/bil.md and doc.md, the BIL, DOC and PUR cards in docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0044,
ADR-0060 and ADR-0061. Read A-174, A-202 and A-203 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md
as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 2c only, on branch b08c2c-statements-remittance: customer statements (listStatements,
createStatement, getStatement, sendStatement) rendered and archived through Documents.requestRenderIn as built in
2b; DOC's rendering of the supplier remittance advice from pur.SupplierRemittanceReady (FR-PUR-013) with PUR's
remittance_document_id; previewTemplateVersion (decide, with an ADR if it changes the planned shape, how a preview
reaches the administrator without serving an unscanned file, A-203); and sendBillingDocument through the outbox
(decide whether a queued send is honest before NTF exists in B11, or leave it to B11 with the reason).
If the phase does not fit, split at a sub-domain boundary and follow "If a session cannot finish".
Stop at the gate and write docs/sessions/B08c2c-statements-remittance.md. End the report with B09a's opening message
(ADR-0026 verification).
```

## B9a — Order core and payments, and online order placement

Branch `b09a-order-core-payments`. Report `docs/sessions/B09a-order-core-payments.md`. **Built; the session split after the sale posting gate (A-208, A-209): the remainder is B09a continued (payments) and B09a continued 2 (orders and online placement) below, both before B09x.** Gate as planned: every payment edge case in the shared brief passes, and an order on any channel posts stock, document, payment and ledger in one transaction.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B08c2c-statements-remittance.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) and PAY requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/ord.md and pay.md, the ORD and PAY cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL
section 7 (the order state machine), the sale posting sequences in docs/ARCHITECTURE.md, and ADR-0010,
ADR-0014, ADR-0021, ADR-0026 and the abuse cases 1, 4, 5 and 12 in docs/security/THREAT_MODEL.md.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a only, on branch b09a-order-core-payments: the sales order and its state machine for
every channel, the sale posting service (stock issue, billing document and payment in one serializable
transaction), returns against the original sale, voids with a supervisor who is not the cashier, price
variance and override limits, payments and allocations, mobile money and the Paystack adapter against
its sandbox, webhook verification (signature, timestamp window, replay cache, amount re-verification),
refunds, unmatched payments, deposits, store credit and settlement reconciliation, and, as ADR-0026
proposes, online order placement and payment. Write every payment edge case test-first. Point of sale,
shifts and offline sync are B09b: do not start them.
Make the owner dashboard's B9a figures live (B05x, A-149): remove `salesTodayPesewas`, `salesYesterdayPesewas`,
`salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and `topMovers` from RPT's PENDING_FIGURES and answer them
from completed orders through a published view, and build the planned tiles getSalesTodayTile and getSalesSeries,
each test-first with its wrong-role refusal.
Unit conversions are built in B06u (A-157, A-163): an order line in a unit other than the product's base unit
converts through MasterDataRefs.toBaseIn, never with a factor of its own.
Add PAY's ◆ events to fin.posting_event_type with their rules, each with an exact-amount matrix test (ADR-0056), and
declare the journal series lock on the sale command, where tills post at once (A-186).
Issue each sale's billing document through BIL's Billing.issueIn in the sale's own transaction, its locks from
Billing.seriesLocksFor (ADR-0060), and build issueProforma (POST /orders/{id}/proforma) on it (A-201); write PAY's
allocations into bil.document_settlement through BIL, never directly (A-200).
Stop at the gate and write docs/sessions/B09a-order-core-payments.md.
```

## B09a continued — Payments: the provider port, webhooks and every payment edge case

Branch `b09a2-payments-provider`, from `main`. Report `docs/sessions/B09a2-payments-provider.md`. Inserted by B9a's split (A-209, ADR-0026 Amendments). **Built; the session split after its webhook and edge-case gate (A-210, A-211): manual receipts, cheques, store credit, reversals and reconciliation are B09a continued 1b below, before B09a continued 2.** Gate: every payment edge case in the shared brief passes, test-first with exact amounts (provider times out after the customer was charged, webhook before the API response, webhook twice, webhook for an order that no longer exists, an amount mismatch on re-verification, a late webhook after expiry, overpayment, underpayment, a partial payment, a refund larger than paid refused, refund fails after the stock was released); a webhook is accepted only with a valid signature, inside the timestamp window, with an unseen event id and its amount re-verified with the provider; every PAY write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a-order-core-payments.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PAY requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pay.md,
the PAY, BIL and FIN cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.9, the sale posting sequences in
docs/ARCHITECTURE.md section 7, ADR-0003, ADR-0010, ADR-0014, ADR-0021 and ADR-0056, the abuse cases 4, 5 and 12 in
docs/security/THREAT_MODEL.md, the webhook section of docs/security/SECURITY_ARCHITECTURE.md, and A-200, A-208 and
A-209 in docs/ASSUMPTIONS.md. Load hakorem-money, hakorem-ledger, hakorem-security-review, hakorem-endpoint,
hakorem-migration, hakorem-runbook and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued only, on branch b09a2-payments-provider, branched from main: PAY's permissions and
grants; recordPayment (cash, bank transfer and cheque pending in 1130, never mobile money or card cleared by hand),
getPayment, listPayments, allocatePayment and unallocatePayment through Payments and Billing.settleIn; the provider
port with the Paystack adapter (no secret in the repository; if the sandbox host is unreachable, a local fake that
implements Paystack's documented API, and never a live endpoint), initiateMobileMoneyCharge outside any business
transaction with a timeout, bounded retry with jitter and a circuit breaker, checkPaymentStatus and the status
lookup worker; receivePaymentWebhook with signature, timestamp window, replay cache and amount re-verification,
never trusting the webhook's amount, and the rejection log; deposits held in 2200 and pay.DepositAllocated,
unmatched payments in 2290, refunds with approval above the automatic limit, markRefundPaid and retryRefund, store
credit, reversePayment, cheque clearing, and settlement and bank statement matching with the break queue, as far as
the gate needs; PAY's remaining ◆ events in fin.posting_event_type with their determinations (1110, 1120, 1100,
1130, 2210, 2290, 6910), each with an exact-amount matrix test (ADR-0056). Write every payment edge case test-first.
If it does not fit, split at a sub-domain boundary (settlement and bank reconciliation last) after the webhook and
edge-case gate is proven and merged.
Stop at the gate, write docs/sessions/B09a2-payments-provider.md, and merge into main when every run on the pull
request is green.
```

## B09a continued 1b — Manual receipts, cheques, store credit, reversals and reconciliation

Branch `b09a2b-payments-reconciliation`, from `main`. Report `docs/sessions/B09a2b-payments-reconciliation.md`. Inserted by B09a continued's split (A-211, ADR-0026 Amendments). **Built; split before settlement and bank reconciliation (A-213):** recordPayment, clearCheque, reversePayment, store credit and listOpenItems are built; the settlement, bank statement and break operations, the refund against a credit note, 1100 for a bank transfer, 2290 and 6910 are B09a continued 1c's. Gate as planned: a cheque of 100,000 is recorded PENDING debiting 1130 only and clears 1130 to 1100, or bounces and reopens the 100,000 item; reversing a 50,000 payment posts the mirror image of its journal on a different person's approval and reopens its allocations; store credit of 6,000 is never redeemed for 6,001 and redeeming 6,000 debits 2210; a settlement of three payments totalling 150,000 with a 1,500 fee posts Dr 1100 148,500, Dr 6910 1,500, Cr 1120 150,000 and an extra 2,000 line raises a break; a break resolves only through an approved posting (2290 for an unidentified receipt); the trial balance still sums to zero; every remaining PAY write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a2-payments-provider.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PAY requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pay.md,
the PAY, BIL and FIN cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.9, ADR-0003, ADR-0014, ADR-0017,
ADR-0056 and ADR-0063, the abuse cases 4 and 12 in docs/security/THREAT_MODEL.md, docs/runbooks/reconciliation-break.md,
and A-200, A-208, A-210 and A-211 in docs/ASSUMPTIONS.md. Load hakorem-money, hakorem-ledger, hakorem-security-review,
hakorem-endpoint, hakorem-migration, hakorem-runbook and hakorem-tests. Use docs/prompts/module-build-prompt.md as the
recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 1b only, on branch b09a2b-payments-reconciliation, branched from main: the remaining PAY
permissions and grants; recordPayment (cash into a named till or with a driver, bank transfer PENDING until a matched
statement line, cheque PENDING in 1130, store credit, never mobile money or card); clearCheque (clear or bounce);
reversePayment with PAYMENT_REVERSAL approval by a different person, posting the exact mirror (pay.PaymentReversed);
store credit as a ledger of entries in 2210 (getCustomerStoreCredit, getMyStoreCredit, refunds to store credit,
redemption as a tender never beyond the balance); a refund against a credit note (Dr 1200); listOpenItems;
importSettlementReport, matchSettlementReport (pay.ProviderSettled: 1100, 6910, 1120), importBankStatement,
matchBankStatement and matchBankStatementLine; listReconciliationBreaks, getReconciliationBreak and
resolveReconciliationBreak with its posting through approval (2290 and the deposit or refund paths). PAY's remaining
◆ events in fin.posting_event_type with their determinations (1100, 1130, 2210, 2290, 6910), each with an
exact-amount matrix test (ADR-0056). Write every money rule test-first.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a2b-payments-reconciliation.md, and merge into main when every run on the pull
request is green.
```

## B09a continued 1c — Settlement reports, bank statements, the break queue and the refund against a credit note

**Run on 2026-11-16 and split (A-215):** the reconciliation part below was built and its gate proved; the refund against a credit note and the cheque's bank payout moved to B09a continued 1d. Branch `b09a2c-payments-settlement`, from `main`. Report `docs/sessions/B09a2c-payments-settlement.md`. Inserted by B09a continued 1b's split (A-213, ADR-0026 Amendments). Gate: a settlement of three payments totalling 150,000 with a 1,500 fee matches all three and posts Dr 1100 148,500, Dr 6910 1,500, Cr 1120 150,000, and an extra 2,000 line not in the system raises a break; a bank transfer recorded PENDING clears (Dr 1100) only from its matched statement line, and an unmatched line raises `BANK_LINE_UNMATCHED`; a break resolves only through an approved posting (2290 for an unidentified receipt), never by hand; a refund against a credit note on a paid document posts Dr 1200; the trial balance still sums to zero; every remaining PAY write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a2b-payments-reconciliation.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PAY requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pay.md,
the PAY, BIL and FIN cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.9, ADR-0003, ADR-0014, ADR-0017,
ADR-0056, ADR-0063 and ADR-0064, the abuse cases 4, 12 and 32 in docs/security/THREAT_MODEL.md,
docs/runbooks/reconciliation-break.md, and A-200, A-208, A-210, A-212 and A-213 in docs/ASSUMPTIONS.md. Load
hakorem-money, hakorem-ledger, hakorem-security-review, hakorem-endpoint, hakorem-migration, hakorem-runbook and
hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase
needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 1c only, on branch b09a2c-payments-settlement, branched from main: the remaining PAY
permissions and grants; importSettlementReport and matchSettlementReport (◆ pay.ProviderSettled: Dr 1100 net against
the bank account, Dr 6910 the fee, Cr 1120 against the provider; SETTLEMENT_AMOUNT_DIFFERS and SETTLEMENT_NOT_FOUND
breaks; nothing corrected automatically); importBankStatement, matchBankStatement and matchBankStatementLine (a bank
transfer recorded PENDING by recordPayment clears from its matched line with pay.PaymentCleared Dr 1100 against the
bank account, its tender determination seeded; an unmatched line raises BANK_LINE_UNMATCHED; a receipt from an
unknown payer is held in 2290); listReconciliationBreaks, getReconciliationBreak and resolveReconciliationBreak with
its posting through approval by a different person (2290 for an unidentified receipt, the deposit or refund paths),
every break kind on the published view pay.pub_reconciliation_break (B09a continued 1b) that the daily exception
report reads; a credit note on a paid document and the refund against it (Dr 1200, the refund drawing on the credit
note's uncredited amount, held by the database); a cheque refunded to its original method through a bank payout.
PAY's remaining ◆ events in fin.posting_event_type with their determinations (1100 for a bank transfer, 2290, 6910),
each with an exact-amount matrix test (ADR-0056). Write every money rule test-first. Keep the A-208 receipt-link
test green.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a2c-payments-settlement.md, and merge into main when every run on the pull
request is green.
```

## B09a continued 1d — The refund against a credit note and the cheque's bank payout

Branch `b09a2d-payments-credit-refunds`, from `main`. Report `docs/sessions/B09a2d-payments-credit-refunds.md`. Inserted by B09a continued 1c's split (A-215, ADR-0026 Amendments). Gate: a credit note on a paid document is issued and a refund against it posts Dr 1200 against the customer and Cr the tender; the refund never exceeds the credit note's amount less what was already refunded against it, held by the database, and two refunds of the last amount at once leave exactly one; the refund is approved with step-up by someone other than its maker and other than the credit note's maker; a cheque is refunded to its original method through a bank payout; the trial balance still sums to zero; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a2c-payments-settlement.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PAY-012, FR-PAY-013 and FR-BIL-007 to FR-BIL-009 of docs/SRS.md (nothing else from the SRS),
docs/data-model/pay.md, docs/data-model/bil.md (credit notes and the settlement summary), the PAY, BIL and FIN cards
in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.9, ADR-0003, ADR-0017, ADR-0056, ADR-0060, ADR-0063, ADR-0064
and ADR-0065, the abuse case 12 in docs/security/THREAT_MODEL.md, and A-200, A-210, A-212, A-214 and A-215 in
docs/ASSUMPTIONS.md. Load hakorem-money, hakorem-ledger, hakorem-security-review, hakorem-endpoint,
hakorem-migration and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other
document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 1d only, on branch b09a2d-payments-credit-refunds, branched from main: a credit note on
a paid document (BIL refuses it today because outstanding would go below zero: a credit beyond what is outstanding
leaves the credited money refundable instead), and requestRefund with creditNoteId: the refund draws on the credit
note's uncredited amount, never beyond the credit note's amount less what was already refunded against it, held by
the database (a trigger under the credit note's lock) and proved under concurrency (two refunds of the last amount
at once: exactly one succeeds); approved by someone other than the refund's maker and other than the credit note's
maker, with step-up (the owner, 2026-11-16: refunds are where till fraud lives); paid, ◆ pay.RefundPaid posts Dr
1200 against the customer and Cr the tender (its rule and an exact-amount matrix test, ADR-0056). A cheque refunded
to its original method through a bank payout (Cr 1100 against the bank account, paid by hand with its reference by
someone other than the maker). Write every money rule test-first. Keep the A-208 receipt-link test green.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a2d-payments-credit-refunds.md, and merge into main when every run on the
pull request is green.
```

## B09a continued 2 — The order endpoints, returns and voids, online placement and the dashboard's sales figures

**Run on 2026-11-16 and split (A-218, A-219):** the real Paystack sandbox run and CR-029 were built and proved; everything from ORD's permissions onward moved to B09a continued 2b below, which runs after B09t2. Branch `b09a3-orders-online`, from `main`. Report `docs/sessions/B09a3-orders-online.md`. Inserted by B9a's split (A-209, ADR-0026 Amendments). Gate as planned: an order on any channel built so far posts stock, document, payment and ledger in one transaction through `SalePosting.postIn` (B9a's proof stands), now reached through the order endpoints and online placement; a void is approved by a supervisor who is not the cashier and leaves a credit note and reversing entries; a return never exceeds what was sold; the owner dashboard's B9a figures answer exactly from completed orders; every ORD write refuses the wrong role.

```text
Before anything else in this phase, the real Paystack sandbox run the owner moved into B9 (A-064, 2026-11-16).
The parent session obtains the owner's Paystack TEST key through the secure credential form before this phase
starts; the network proxy injects it for the Paystack host, so the key never appears in the repository, a log,
a test or a fixture (send a dummy bearer value; the proxy replaces it). Never use or ask for a live key (B13).
Write a sandbox suite, run on demand and never in CI (it needs the network and the owner's key): every edge case
B09a continued proved against the local fake, mobile money included (initialise, charge, verify, the transaction
list the sweep reads, refunds, a timeout retry reusing our reference), run against the real sandbox. Webhooks
cannot reach this machine; say so, and check the signature scheme against a captured sandbox payload if one can
be obtained. Report every place where Paystack's real behaviour differs from its documentation or from the fake,
and fix the fake (and the adapter, test-first) to match the real behaviour.
Also in the sandbox run (owner, 2026-11-16, ADR-0065): call Paystack's Settlements API (the settlements list and the
transactions inside a settlement) and report exactly what it returns, field by field, and whether it covers what the
settlement matching needs (our reference, the amount, the fee, the settlement date and id, the bank payout). The
settlement is to be read from that API, never from a dashboard CSV export. A sandbox account may hold no settlement:
say so plainly, and record what the empty answer looks like. Do not rewrite the matching here; that is B09r.
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a2d-payments-credit-refunds.md, or the
last report of its own splits).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021 and ADR-0026, the abuse cases 1, 3 and 12 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-209, A-210, A-211, A-212, A-213 and A-216 in docs/ASSUMPTIONS.md, ADR-0063, ADR-0064 and ADR-0066 (a void's refund is a reversal or a refund to store credit; returns use the refund against a credit note, built in B09a continued 1d). Load hakorem-pricing, hakorem-money, hakorem-stock, hakorem-ledger,
hakorem-documents, hakorem-security-review, hakorem-endpoint, hakorem-migration and hakorem-tests. Use
docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2 only, on branch b09a3-orders-online, branched from main: ORD's permissions and
grants; createOrder, getOrder, listOrders, listOrderHistory, confirmOrder (reserving every line or staying PLACED
with the shortfall), cancelOrder (releasing reservations and requesting the refund in one transaction) and voidOrder
(a supervisor who is not the cashier, a credit note and reversing entries, every void on the exception report),
each test-first with its wrong-role refusal; returns against the original sale (createReturn, getReturn,
submitReturn, never more than sold less returned, by database trigger); price variance and override limits per
role with approval by a different user (PRICE_OVERRIDE_NEEDS_APPROVAL becomes an approval request); issueProforma
(POST /orders/{id}/proforma) on Billing.issueIn (A-201); online order placement and payment (placeOrder, trackOrder,
listMyOrders, getMyOrder) on B09a continued's provider port (cancelOrder
releases the order's pending charges through ProviderPayments.releaseChargeIn, an order confirms on pay.PaymentCleared
only when it is not heldAsUnmatched, and the webhook for a cancelled order is proved again through cancelOrder, A-210); and the owner dashboard's B9a figures (A-149): remove
`salesTodayPesewas`, `salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and
`topMovers` from RPT's PENDING_FIGURES and answer them from completed orders through a published view, and build
the planned tiles getSalesTodayTile and getSalesSeries, each test-first with its wrong-role refusal. Extend the seed
with a trading day of sales posted through SalePosting, keeping the B5 hand count and the trial balance tests true.
CR-029 (owner, 2026-11-16): `Cart.checkoutId` (uuid or null), the open checkout while the cart's status is CHECKOUT
and null otherwise, additive, so a second device or tab with the same cart cookie can open the checkout it is in;
test that it is null again once the checkout completes, expires or is abandoned, and never names another cart's.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3-orders-online.md, and merge into main when every run on the pull
request is green.
```

## B09t2 — Seed and test dates from the clock, before they expire

Branch `b09t2-dates-from-clock`, from `main`. Report `docs/sessions/B09t2-dates-from-clock.md`. Inserted by the parent session on 2026-11-16 from B09t's findings (ADR-0026 Amendments), urgent: **it must merge before 2026-12-01**, when real CI starts failing. Gate: no seed row and no test depends on a fixed calendar date that real time will pass (every date is built from the seed's or the test's clock, or the test pins its own clock to a fixed instant and passes it everywhere); the full integration suite passes with every test file's clock forced to 2026-12-31T10:00:00Z and to 2027-03-01T10:00:00Z, except failures caused only by a container's own clock, each named; the refund payout check compares against an application-written instant; nothing skipped or loosened.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report, then docs/sessions/B09t-clock-sweep.md (its findings and
"still failing" list), ADR-0067 and A-217. Load hakorem-seed, hakorem-tests and hakorem-migration.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09t2 only, on branch b09t2-dates-from-clock, branched from main:
1. The seeded egg lot EGG-BIG-2026-1110 expires on 2026-12-01 (src/seed/farm-inv.ts:78), so sale-posting,
   storefront-checkout and order-payment-rules fail from 2026-12-02. Make every seeded expiry, best-before, due and
   valid-from/to date relative to the seed's clock, keeping each test's exact amounts; search the whole seed and test
   support for other fixed dates and fix them the same way.
2. fin/financial-statements "reads a locked period with lines from its balances" pins November 2026: build its period
   from the test clock so it holds in any month.
3. src/modules/pay/application/refunds.ts:222 compares a payout date with the refund's database-defaulted created_at:
   write the refund's created_at from the application clock (or compare against an application-written instant),
   test-first with a ManualClock across midnight.
4. file-store's signed links fail under a forced clock because the object store container checks them against its own
   clock: record it in the report as a container artifact, not a defect.
Prove each fix with the forced-clock sweep (the scratch method of B09t: shift each test file's clock; never commit it)
failing before and passing after.
Stop at the gate, write docs/sessions/B09t2-dates-from-clock.md, and merge into main when every run on the pull
request is green.
```

## B09a continued 2b — The order endpoints, returns and voids, online placement and the dashboard's sales figures

**Run on 2026-11-17 and split (A-224, A-225):** ORD's first permissions and grants, getOrder, listOrders, listOrderHistory, createOrder and confirmOrder with the `OrderConfirmationPolicy` port were built and proved (contract 1.47.0); everything else moved to B09a continued 2c below, which runs next, before B09x. Branch `b09a3b-orders-online`, from `main`. Report `docs/sessions/B09a3b-orders-online.md`. Inserted by B09a continued 2's split (A-219, ADR-0026 Amendments); runs after B09t2 and before B09x. Gate: an order on any channel built so far posts stock, document, payment and ledger in one transaction through `SalePosting.postIn` (B9a's proof stands), now reached through the order endpoints and online placement; a void is approved by a supervisor who is not the cashier and leaves a credit note and reversing entries; a return never exceeds what was sold; the owner dashboard's B9a figures answer exactly from completed orders; every ORD write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09t2-dates-from-clock.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021 and ADR-0026, the abuse cases 1, 3 and 12 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-209, A-210, A-211, A-212, A-213, A-216 and A-218 in docs/ASSUMPTIONS.md, ADR-0063, ADR-0064 and
ADR-0066 (a void's refund is a reversal or a refund to store credit; returns use the refund against a credit note,
built in B09a continued 1d), and ADR-0067 with A-217 (a rule's "now" is the application clock's). Load hakorem-pricing, hakorem-money, hakorem-stock, hakorem-ledger,
hakorem-documents, hakorem-security-review, hakorem-endpoint, hakorem-migration and hakorem-tests. Use
docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2b only, on branch b09a3b-orders-online, branched from main: ORD's permissions and
grants; createOrder, getOrder, listOrders, listOrderHistory, confirmOrder (reserving every line or staying PLACED
with the shortfall), cancelOrder (releasing reservations and requesting the refund in one transaction) and voidOrder
(a supervisor who is not the cashier, a credit note and reversing entries, every void on the exception report),
each test-first with its wrong-role refusal; returns against the original sale (createReturn, getReturn,
submitReturn, never more than sold less returned, by database trigger); price variance and override limits per
role with approval by a different user (PRICE_OVERRIDE_NEEDS_APPROVAL becomes an approval request); issueProforma
(POST /orders/{id}/proforma) on Billing.issueIn (A-201); online order placement and payment (placeOrder, trackOrder,
listMyOrders, getMyOrder) on B09a continued's provider port (cancelOrder
releases the order's pending charges through ProviderPayments.releaseChargeIn, an order confirms on pay.PaymentCleared
only when it is not heldAsUnmatched, and the webhook for a cancelled order is proved again through cancelOrder, A-210); and the owner dashboard's B9a figures (A-149): remove
`salesTodayPesewas`, `salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and
`topMovers` from RPT's PENDING_FIGURES and answer them from completed orders through a published view, and build
the planned tiles getSalesTodayTile and getSalesSeries, each test-first with its wrong-role refusal. Extend the seed
with a trading day of sales posted through SalePosting, keeping the B5 hand count and the trial balance tests true.
CR-029 was built in B09a continued 2 (`Cart.checkoutId`, contract 1.46.0): when placeOrder completes a checkout,
prove through placeOrder itself that the cart's checkoutId is null again (B09a continued 2 proved it for an expiry,
and for a completion only by setting the rows directly). The integration tests run against the local Paystack fake,
which now answers as Paystack's test mode did (A-218): its MTN test number pays at once, a payer email on `.example`
is refused, and a refund's idempotency key is honoured only through the adapter's note lookup.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL (due dates, expiries, holds, business
days and as-of times take the application clock, as a parameter or platform.app_now()); and no new fixed calendar
date in the seed or a test (build dates from the seed's or the test's clock); B09t2 made the seed's dates relative
to its clock (src/seed/seed-calendar.ts, A-220, A-222), so the seeded trading day this phase adds takes its dates from
the same seed calendar.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3b-orders-online.md, and merge into main when every run on the pull
request is green.
```

## B09a continued 2c — Cancellations, voids and returns, price override approvals, the proforma, online placement and the dashboard's sales figures

**Run on 2026-11-17 and split (A-226, A-227):** ORD's reversal permissions, grants and the `SALE_VOID` policy, cancelOrder and voidOrder were built and proved (contract 1.48.0); everything else moved to B09a continued 2d below, which runs next, before B09x. Branch `b09a3c-orders-reversals`, from `main`. Report `docs/sessions/B09a3c-orders-reversals.md`. Inserted by B09a continued 2b's split (A-225, ADR-0026 Amendments); runs after it and before B09x. Gate: an order on any channel built so far posts stock, document, payment and ledger in one transaction through `SalePosting.postIn` (B9a's proof stands), now reached through the order endpoints and online placement; a cancellation releases the order's reservations and pending charges and requests the refund in one transaction; a void is approved by a supervisor who is not the cashier and leaves a credit note and reversing entries; a return never exceeds what was sold less what was returned, held by a database trigger and proved under concurrency; a price below list is approved by a different user; the owner dashboard's B9a figures answer exactly from completed orders; every ORD write refuses the wrong role. If it does not fit, split again at a sub-domain boundary (reversals; pricing approvals and the proforma; online placement; the dashboard and the seed).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3b-orders-online.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021 and ADR-0026, the abuse cases 1, 3 and 12 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-209, A-210, A-211, A-212, A-213, A-216, A-218, A-224 and A-225 in docs/ASSUMPTIONS.md, ADR-0063,
ADR-0064 and ADR-0066 (a void's refund is a reversal or a refund to store credit; returns use the refund against a
credit note, built in B09a continued 1d), and ADR-0067 with A-217 (a rule's "now" is the application clock's). Load
hakorem-pricing, hakorem-money, hakorem-stock, hakorem-ledger, hakorem-documents, hakorem-security-review,
hakorem-endpoint, hakorem-migration and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2c only, on branch b09a3c-orders-reversals, branched from main. B09a continued 2b built
ORD's read, create and confirm permissions (0188, 0189) and getOrder, listOrders, listOrderHistory, createOrder and
confirmOrder in `Orders` (src/modules/ord/application/orders.ts), with the `OrderConfirmationPolicy` port; build on
them: the permissions and grants of what follows; cancelOrder (releasing the order's reservations, held by the order
as `holder_document_id`, and requesting the refund of anything paid, in one transaction) and voidOrder (a supervisor
who is not the cashier, a credit note and reversing entries, every void on the exception report), each test-first
with its wrong-role refusal; returns against the original sale (createReturn, getReturn, submitReturn, never more
than sold less returned, by database trigger, proved under concurrency); price variance and override limits per role
with approval by a different user (PRICE_OVERRIDE_NEEDS_APPROVAL becomes an approval request, on createOrder and on
the sale posting alike; the database already requires the approval once an order is past PLACED); issueProforma
(POST /orders/{id}/proforma) on Billing.issueIn (A-201); online order placement and payment (placeOrder, trackOrder,
listMyOrders, getMyOrder) on B09a continued's provider port (cancelOrder releases the order's pending charges through
ProviderPayments.releaseChargeIn, an order confirms on pay.PaymentCleared only when it is not heldAsUnmatched, and
the webhook for a cancelled order is proved again through cancelOrder, A-210); and the owner dashboard's B9a figures
(A-149): remove `salesTodayPesewas`, `salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`,
`salesSeries` and `topMovers` from RPT's PENDING_FIGURES and answer them from completed orders through a published
view, and build the planned tiles getSalesTodayTile and getSalesSeries, each test-first with its wrong-role refusal.
Extend the seed with a trading day of sales posted through SalePosting, keeping the B5 hand count and the trial
balance tests true. CR-029 was built in B09a continued 2 (`Cart.checkoutId`, contract 1.46.0): when placeOrder
completes a checkout, prove through placeOrder itself that the cart's checkoutId is null again. The integration tests
run against the local Paystack fake, which answers as Paystack's test mode did (A-218): its MTN test number pays at
once, a payer email on `.example` is refused, and a refund's idempotency key is honoured only through the adapter's
note lookup.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL (due dates, expiries, holds, business
days and as-of times take the application clock, as a parameter or platform.app_now()); and no new fixed calendar
date in the seed or a test (build dates from the seed's or the test's clock); the seeded trading day this phase adds
takes its dates from the seed calendar (src/seed/seed-calendar.ts, A-220, A-222).
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3c-orders-reversals.md, and merge into main when every run on the pull
request is green.
```

## B09a continued 2d — Returns, price override approvals, the proforma, online placement and the dashboard's sales figures

**Run on 2026-11-17 and split (A-228, A-229):** the void's test-first gap was closed and returns were built and proved (contract 1.49.0); everything else moved to B09a continued 2e below, which runs next, before B09x. Branch `b09a3d-orders-returns`, from `main`. Report `docs/sessions/B09a3d-orders-returns.md`. Inserted by B09a continued 2c's split (A-227, ADR-0026 Amendments); runs after it and before B09x. Gate: a return never exceeds what was sold less what was returned, held by a database trigger and proved under concurrency, and is refunded against its own credit note by a different approver; a price below list is approved by a different user; an order on any channel built so far posts stock, document, payment and ledger in one transaction through `SalePosting.postIn` (B9a's proof stands), now reached through the order endpoints and online placement; the owner dashboard's B9a figures answer exactly from completed orders; every ORD write refuses the wrong role. If it does not fit, split again at a sub-domain boundary (returns; pricing approvals and the proforma; online placement; the dashboard and the seed).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3c-orders-reversals.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021 and ADR-0026, the abuse cases 3 and 12 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-210, A-216, A-218, A-224, A-226 and A-227 in docs/ASSUMPTIONS.md, ADR-0063 and ADR-0066 (returns use
the refund against a credit note, built in B09a continued 1d), and ADR-0067 with A-217 (a rule's "now" is the
application clock's). Load hakorem-pricing, hakorem-money, hakorem-stock, hakorem-ledger, hakorem-documents,
hakorem-security-review, hakorem-endpoint, hakorem-migration and hakorem-tests. Use docs/prompts/module-build-prompt.md
as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2d only, on branch b09a3d-orders-returns, branched from main. B09a continued 2b and 2c
built ORD's order record and its reversals in `Orders` and `OrderReversals` (src/modules/ord/application/), with
the in-transaction ports they call: BIL's `Billing.creditIn` (a credit note issued at once under the caller's own
approval), PAY's `Refunds.requestIn` and `Receipts.reverseApprovedIn`, and INV's `Reservations.releaseHeldByIn`.
Build on them, each test-first with its wrong-role refusal: the permissions and grants of what follows; returns
against the original sale (createReturn, getReturn, submitReturn, `ord.order_return` and `ord.order_return_line`,
never more than sold less returned, by database trigger, proved under concurrency; submitReturn issues the credit note
through `Billing.creditIn`, posts the stock back through INV by its disposition and asks for the refund against that
credit note through `Refunds.requestIn`, approved by someone who is neither the return's maker nor the credit note's,
ADR-0066); price variance and override limits per role with approval by a different user (PRICE_OVERRIDE_NEEDS_APPROVAL
becomes an approval request, on createOrder and on the sale posting alike; the database already requires the approval
once an order is past PLACED); issueProforma (POST /orders/{id}/proforma) on Billing.issueIn (A-201); online order
placement and payment (placeOrder, trackOrder, listMyOrders, getMyOrder) on B09a continued's provider port (an order
confirms on pay.PaymentCleared only when it is not heldAsUnmatched; cancelOrder already releases the order's pending
charges and the late webhook clears as unmatched, proved in B09a continued 2c); and the owner dashboard's B9a figures
(A-149): remove `salesTodayPesewas`, `salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`,
`salesSeries` and `topMovers` from RPT's PENDING_FIGURES and answer them from completed orders through a published
view (a VOIDED order is not a sale), and build the planned tiles getSalesTodayTile and getSalesSeries.
Extend the seed with a trading day of sales posted through SalePosting, keeping the B5 hand count and the trial
balance tests true. CR-029 was built in B09a continued 2 (`Cart.checkoutId`, contract 1.46.0): when placeOrder
completes a checkout, prove through placeOrder itself that the cart's checkoutId is null again. The integration tests
run against the local Paystack fake, which answers as Paystack's test mode did (A-218): its MTN test number pays at
once, a payer email on `.example` is refused, and a refund's idempotency key is honoured only through the adapter's
note lookup.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL (due dates, expiries, holds, business
days and as-of times take the application clock, as a parameter or platform.app_now()); and no new fixed calendar
date in the seed or a test (build dates from the seed's or the test's clock); the seeded trading day this phase adds
takes its dates from the seed calendar (src/seed/seed-calendar.ts, A-220, A-222).
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3d-orders-returns.md, and merge into main when every run on the pull
request is green.
```

## B09a continued 2e — Price override approvals, the proforma, online placement and the dashboard's sales figures

**Run on 2026-11-17 and split (A-230, A-231):** price override approvals (createOrder and the sale posting, held by the database) and `issueProforma` were built and proved (contract 1.50.0); online placement, the dashboard's sales figures and the seeded trading day moved to B09a continued 2f below, which runs next, before B09x. Branch `b09a3e-orders-online`, from `main`. Report `docs/sessions/B09a3e-orders-online.md`. Inserted by B09a continued 2d's split (A-229, ADR-0026 Amendments); runs after it and before B09x. Gate: a price below list is approved by a different user, on createOrder and on the sale posting alike; an order on any channel built so far posts stock, document, payment and ledger in one transaction through `SalePosting.postIn` (B9a's proof stands), now reached through the order endpoints and online placement; the owner dashboard's B9a figures answer exactly from completed orders (a VOIDED order is not a sale, and a completed return is taken off the day it was approved); the seeded trading day keeps the B5 hand count and the trial balance true; every ORD write refuses the wrong role. If it does not fit, split again at a sub-domain boundary (pricing approvals and the proforma; online placement; the dashboard and the seed).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3d-orders-returns.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021, ADR-0026 and ADR-0068, the abuse case 3 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-210, A-218, A-224, A-226, A-228 and A-229 in docs/ASSUMPTIONS.md, and ADR-0067 with A-217 (a rule's
"now" is the application clock's). Load hakorem-pricing, hakorem-money, hakorem-ledger, hakorem-documents,
hakorem-security-review, hakorem-endpoint, hakorem-migration, hakorem-seed and hakorem-tests. Use
docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2e only, on branch b09a3e-orders-online, branched from main. B09a continued 2b to 2d
built ORD's order record, its reversals and returns in `Orders`, `OrderReversals` and `Returns`
(src/modules/ord/application/). Build on them, each test-first with its wrong-role refusal: the permissions and
grants of what follows; price variance and override limits per role with approval by a different user
(PRICE_OVERRIDE_NEEDS_APPROVAL becomes an approval request, on createOrder and on the sale posting alike; the
database already requires the approval once an order is past PLACED); issueProforma (POST /orders/{id}/proforma) on
Billing.issueIn (A-201); online order placement and payment (placeOrder, trackOrder, listMyOrders, getMyOrder) on
B09a continued's provider port (an order confirms on pay.PaymentCleared only when it is not heldAsUnmatched;
cancelOrder already releases the order's pending charges and the late webhook clears as unmatched, proved in B09a
continued 2c); and the owner dashboard's B9a figures (A-149, CR-013): remove `salesTodayPesewas`,
`salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and `topMovers` from RPT's
PENDING_FIGURES and answer them from completed orders through a published view (a VOIDED order is not a sale; decide
and record how a completed return's credit note counts), and build the planned tiles getSalesTodayTile and
getSalesSeries. Extend the seed with a trading day of sales posted through SalePosting, keeping the B5 hand count and
the trial balance tests true. CR-029 was built in B09a continued 2 (`Cart.checkoutId`, contract 1.46.0): when
placeOrder completes a checkout, prove through placeOrder itself that the cart's checkoutId is null again. The
integration tests run against the local Paystack fake, which answers as Paystack's test mode did (A-218): its MTN
test number pays at once, a payer email on `.example` is refused, and a refund's idempotency key is honoured only
through the adapter's note lookup.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL (due dates, expiries, holds, business
days and as-of times take the application clock, as a parameter or platform.app_now()); and no new fixed calendar
date in the seed or a test (build dates from the seed's or the test's clock); the seeded trading day this phase adds
takes its dates from the seed calendar (src/seed/seed-calendar.ts, A-220, A-222).
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3e-orders-online.md, and merge into main when every run on the pull
request is green.
```

## B09a continued 2f — Online placement, the dashboard's sales figures and the seeded trading day

**Run on 2026-11-17 and split (A-232, A-233):** online placement and payment (`placeOrder`, `trackOrder`, `listMyOrders`, `getMyOrder`, CR-029 through `placeOrder`) were built and proved (contract 1.51.0, ADR-0070); the dashboard's sales figures and the seeded trading day moved to B09a continued 2g below, which runs next, before B09x. Branch `b09a3f-orders-online`, from `main`. Report `docs/sessions/B09a3f-orders-online.md`. Inserted by B09a continued 2e's split (A-231, ADR-0026 Amendments); runs after it and before B09x. Gate: an online order posts stock, document, payment and ledger in one transaction through `SalePosting.postIn` (B9a's proof stands), placed from a checkout and confirmed on `pay.PaymentCleared` only when the payment is not held as unmatched; the customer reads only their own orders; the owner dashboard's B9a figures answer exactly from completed orders (a VOIDED order is not a sale, and a completed return is taken off the day it was approved); the seeded trading day keeps the B5 hand count and the trial balance true; every ORD write refuses the wrong role. If it does not fit, split again at a sub-domain boundary (online placement; the dashboard and the seed).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3e-orders-online.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, SHP and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021, ADR-0026 and ADR-0069, and A-149, A-208, A-210, A-218, A-224, A-226, A-228, A-230 and A-231 in
docs/ASSUMPTIONS.md, and ADR-0067 with A-217 (a rule's "now" is the application clock's). Load hakorem-money,
hakorem-ledger, hakorem-security-review, hakorem-endpoint, hakorem-migration, hakorem-offline (only if a POS path is
touched), hakorem-seed and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other
document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2f only, on branch b09a3f-orders-online, branched from main. B09a continued 2b to 2e
built ORD's order record, reversals, returns and price override approvals in `Orders`, `OrderReversals`, `Returns`
and `PriceOverrides` (src/modules/ord/application/). Build on them, each test-first with its wrong-role refusal: the
permissions and grants of what follows; online order placement and payment (placeOrder, trackOrder, listMyOrders,
getMyOrder) on B09a continued's provider port (an order confirms on pay.PaymentCleared only when it is not
heldAsUnmatched; cancelOrder already releases the order's pending charges and the late webhook clears as unmatched,
proved in B09a continued 2c; an online price is the engine's, so no override arises; the customer reads only their own
orders); and the owner dashboard's B9a figures (A-149, CR-013): remove `salesTodayPesewas`, `salesYesterdayPesewas`,
`salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and `topMovers` from RPT's PENDING_FIGURES and answer them
from completed orders through a published view (a VOIDED order is not a sale; decide and record how a completed
return's credit note counts), and build the planned tiles getSalesTodayTile and getSalesSeries. Extend the seed with a
trading day of sales posted through SalePosting, keeping the B5 hand count and the trial balance tests true. CR-029 was
built in B09a continued 2 (`Cart.checkoutId`, contract 1.46.0): when placeOrder completes a checkout, prove through
placeOrder itself that the cart's checkoutId is null again. The integration tests run against the local Paystack fake,
which answers as Paystack's test mode did (A-218): its MTN test number pays at once, a payer email on `.example` is
refused, and a refund's idempotency key is honoured only through the adapter's note lookup.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL (due dates, expiries, holds, business
days and as-of times take the application clock, as a parameter or platform.app_now()); and no new fixed calendar
date in the seed or a test (build dates from the seed's or the test's clock); the seeded trading day this phase adds
takes its dates from the seed calendar (src/seed/seed-calendar.ts, A-220, A-222).
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3f-orders-online.md, and merge into main when every run on the pull
request is green.
```

## B09a continued 2g — The dashboard's sales figures and the seeded trading day

**Run on 2026-11-17 to its gate (A-234, A-235):** contract 1.52.0, migration 0206. Branch `b09a3g-dashboard-seed`, from `main`. Report `docs/sessions/B09a3g-dashboard-seed.md`. Inserted by B09a continued 2f's split (A-233, ADR-0026 Amendments); runs after it and before B09x. Gate: the owner dashboard's B9a figures answer exactly, to the pesewa, from completed orders through a published view (a VOIDED order is not a sale, and a completed return is taken off the day it was approved, or as the session decides and records), with every wrong role refused; the planned tiles getSalesTodayTile and getSalesSeries answer the same figures; the seeded trading day, posted through `SalePosting`, keeps the B5 hand count, the trial balance at 0 and every existing exact amount true. If it does not fit, split again at a sub-domain boundary (the dashboard; the seed).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3f-orders-online.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), in particular CR-013:
implement what is reasonable, record in the report what you declined and why, never edit that file and never open
frontend source.
For this phase, read FR-RPT-001 of docs/SRS.md (nothing else from the SRS), docs/data-model/ord.md, the ORD and RPT
cards in docs/MODULE_BOUNDARIES.md, ADR-0011, ADR-0023, ADR-0026 and ADR-0067, and A-149, A-208, A-217, A-220,
A-222, A-226, A-228 and A-233 in docs/ASSUMPTIONS.md. Load hakorem-money, hakorem-ledger, hakorem-endpoint,
hakorem-migration, hakorem-seed and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe. Do not read
any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2g only, on branch b09a3g-dashboard-seed, branched from main. Each test-first with its
wrong-role refusal: the owner dashboard's B9a figures (A-149, CR-013): remove `salesTodayPesewas`,
`salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and `topMovers` from RPT's
PENDING_FIGURES (src/modules/rpt/) and answer them from completed orders through a published ORD view (ADR-0011,
ADR-0023; RPT never reads ORD's tables): a VOIDED order is not a sale; decide and record how a completed return's
credit note counts; days are Africa/Accra business dates from the application clock. Build the planned tiles
getSalesTodayTile and getSalesSeries on the same figures. Assert exact pesewa figures on the seeded trading day,
with every wrong role refused (`rpt.dashboard.owner`, `rpt.tile.read`). Extend the seed with a trading day of sales
posted through SalePosting (hakorem-seed), its dates from the seed calendar (src/seed/seed-calendar.ts, A-220,
A-222), keeping the B5 hand count, the trial balance at 0 and every existing exact amount in the tests true.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL, and no new fixed calendar date in the
seed or a test.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3g-dashboard-seed.md, and merge into main when every run on the pull
request is green.
```

## B09x — Contract requests: empty list examples, the seeded role matrix and the owner's catch-ups

Branch `b09x-contract-requests`, from `main`. Report `docs/sessions/B09x-contract-requests.md`. Inserted by the owner on 2026-11-16 after B9a (ADR-0026 Amendments): CR-005 was declined only for its size, and CR-023 was named for scheduling by B08 continued 2b. Gate: every list operation in the contract, from code and planned, has a named empty example beside its populated one, checked by a contract test that fails when a list operation lacks it; the seeded role matrix (every seeded role with its full permissions) is published in the contract as an `x-seeded-roles` extension or a complete `listRoles` example, generated from the IAM seed by `pnpm contract:generate` and failing CI on drift; nothing removed, renamed or retyped; and a supplier payment is numbered from its `SPY` series when it is marked paid, gap-free, and its remittance advice prints that number (A-205); a Farm hand death report without its photograph is refused whatever its value while other makers keep the threshold; a processing reversal's approval links to its order (CR-027); getShopProfile answers anonymously with the contact fields only (CR-028).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3g-dashboard-seed.md, or the last
report of its own splits).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), in particular CR-005 and
CR-023: implement them, answer every other request in the report, never edit that file and never open frontend source.
For this phase, read docs/API.md (examples and lists), scripts/contract/, the IAM seed migrations and
ADR-0038. Load hakorem-endpoint, hakorem-seed and hakorem-tests.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09x only, on branch b09x-contract-requests, branched from main: a named empty example (`empty`) on
every list operation, generated by one scripted pass over the fragments and the planned file and kept by a contract
test; the seeded role matrix published in the contract from the IAM seed, generated and checked in CI; CR-023's
confirmation of the Farm hand's grants answered from the seed in the report. The published matrix must show the
credit-note grants as the owner set them on 2026-11-16 (migration 0174): `bil.credit_note.create` for the Owner, the
Accountant and the Manager, never the Cashier, and `bil.credit_note.approve` for the Owner and the Manager.
Also (A-205): allocate `pur.supplier_payment.payment_no` from its `SPY` series through `platform.allocate_number` in the
transaction that marks the payment paid, test-first with a concurrent gap-free test, and print it on the remittance
advice in place of the payment id (load hakorem-documents and hakorem-migration). Examples and an extension only: a
contract minor version, a changelog entry, and the cold-read summary updated.
Also, from the owner (2026-11-16), each test-first with its wrong-role refusal:
(1) The Farm hand's death report always needs a photograph, whatever its value: the role cannot see the value, so it
cannot know when the threshold applies (the frontend already requires it). Enforce it on the server in the care
operations (reportCareMortality and submitCareMortalityRecord refuse a Farm hand report without its EVIDENCE photograph,
MORTALITY_PHOTO_REQUIRED), with a test below the 50,000 threshold; every other maker keeps the threshold rule unchanged,
also tested.
(2) CR-027: an approval request for a processing reversal links to its order, additively: an optional
`ApprovalRequest.relatedDocument` (`DocumentRef`) naming the order, or `reversalId` on listProcessingOrders, whichever
is cheaper. Never change the existing `subject`, which stays the reversal.
(3) CR-028: getShopProfile (GET /shop/profile), anonymous and cacheable: the trading name, a phone and a WhatsApp number
in E.164, the farm's address and directions, and opening hours, read from the business profile; it exposes nothing
else from it (no TIN, bank or staff detail), proved by a test of the response's keys; the seed uses invented,
clearly fictional numbers (hakorem-seed).
Stop at the gate, write docs/sessions/B09x-contract-requests.md, and merge into main when every run on the pull
request is green.
```

## B09x continued — The shop's contact details on the business profile (CR-028)

Branch `b09x2-shop-profile`, from `main`. Report `docs/sessions/B09x2-shop-profile.md`. Inserted by B09x on 2026-11-17 (ADR-0026 Amendments, A-241): B09x built CR-005, CR-023, A-205, the Farm hand's photograph and CR-027, and split before CR-028, because nothing stores the business profile yet (FR-AUD-008). Gate: the business profile is stored in `platform.setting` as the data model says, and written only through AUD's audited administration (permission `aud.setting.manage`, step-up, the value before and after in the audit event); `getShopProfile` (GET /shop/profile) answers anonymously and cacheably with the trading name, a phone and a WhatsApp number in E.164, the farm's address and directions, and opening hours, and nothing else from the profile (no TIN, VAT number, bank, email or staff detail), proved by a test that lists the response's keys exactly; it answers 404 while no profile is set, never an invented one; the seed writes the profile through AUD's service as the seeded Owner, with invented, clearly fictional numbers from the seed's own block; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09x-contract-requests.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), in particular CR-028:
implement it, answer every other request in the report, never edit that file and never open frontend source.
For this phase, read FR-AUD-008 and FR-SHP-001 in docs/SRS.md (nothing else from the SRS), docs/data-model/platform.md
(`platform.setting`), docs/data-model/aud.md, the AUD and SHP cards in docs/MODULE_BOUNDARIES.md, and grep
contract/openapi.yaml for getBusinessProfile, updateBusinessProfile and BusinessProfile. Load hakorem-endpoint,
hakorem-seed, hakorem-tests and hakorem-security-review.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09x continued only, on branch b09x2-shop-profile, branched from main:
(1) The business profile (FR-AUD-008), stored in platform.setting as the data model says, read and written only through
AUD: the fields of the planned BusinessProfile, plus a WhatsApp number, directions and opening hours, each phone in
E.164; written by an audited AUD service (aud.setting.manage, step-up, before and after in the audit event), with
updateBusinessProfile and getBusinessProfile moved into code if they fit, each test-first with its wrong-role refusal.
(2) CR-028: getShopProfile (GET /shop/profile, tag shp), anonymous and cacheable (Cache-Control, the public catalogue
rate limit): the trading name, a phone and a WhatsApp number in E.164, the farm's address and directions, and opening
hours, read through AUD's published interface; it exposes nothing else from the profile (no TIN, VAT number, bank,
email or staff detail), proved by a test that lists the response's keys exactly; 404 while no profile is set.
(3) The seed writes the profile through AUD's service as the seeded Owner, with invented, clearly fictional numbers
from the seed's own +2332000001.. block (hakorem-seed), and a second run changes nothing.
Additive only: a contract minor version, a changelog entry, and the cold-read summary updated. No new now() in business
SQL and no fixed calendar dates in the seed or tests (ADR-0067, A-220).
Stop at the gate, write docs/sessions/B09x2-shop-profile.md, and merge into main when every run on the pull request
is green.
```

## B09q — QR codes, barcodes, SKUs and public IDs (contract 2.0.0)

Branch `b09q-ids-barcodes`, from `main`. Report `docs/sessions/B09q-ids-barcodes.md`. Inserted by the owner on 2026-11-17 after B09x continued and before B9b (ADR-0026 Amendments). The owner approved the breaking bump to **2.0.0**. Gate: no QR code anywhere but TOTP enrolment; no product barcode field, barcode lookup or till scanning, and no barcode on product or lot/animal labels, while the meat pack labels are byte-for-byte as built; a product's SKU is generated by the server, unique, never reused and never accepted as input; customers and suppliers carry an unguessable public ID, shown in responses and accepted in search, in place of their sequential numbers; knowing a public ID, a SKU or a UUID reads nothing without authorisation, and every link sent to a customer carries its own long random token, each proved by a test; contract 2.0.0 with a loud changelog listing everything removed and added, and every example updated.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09x2-shop-profile.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decisions below, docs/API.md (versioning), docs/CONTRACT_CHANGELOG.md's cold-read
summary, ADR-0038, docs/security/SECURE_CODING_STANDARDS.md on identifiers and links, and the MDM, INV and PRC cards in
docs/MODULE_BOUNDARIES.md. Load hakorem-endpoint, hakorem-migration, hakorem-security-review, hakorem-seed, hakorem-adr
and hakorem-tests. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09q only, on branch b09q-ids-barcodes, branched from main. The owner's decisions (2026-11-17):
1. QR codes: keep the TOTP enrolment QR only; remove any other QR (none is built today besides TOTP: prove it by a
   search in the report, and keep it that way with a test or lint rule if cheap).
2. Barcodes: remove the product barcode field (mdm.product.barcode by an expand-then-contract migration, its unique
   index, the import sheet column), any barcode lookup and till scanning, and the barcode from getProductLabel and
   getStockUnitLabel (owner's answer: remove both, keep the printed text: SKU, lot code, tag, dates, weight). Leave the
   meat pack labels (PRC, migration 0085, printPackLabels) exactly as built, barcode included: meat is future work and
   is not to be touched; a test proves their output is unchanged.
3. SKU: generated by the server at creation, a short prefix from the product's category and a zero-padded number
   (EGG-0001): unique, never reused (its own sequence per prefix, never reset), never edited, never accepted as input on
   create, update or import (a request carrying it is 422, not silently ignored). The category gains its short prefix if
   it has none. Changing a product's category never changes its SKU. Backfill the seed through the services, keeping
   every test's exact amounts.
4. Public IDs: UUIDs stay as primary keys and in API paths and are never shown to people. Customers and suppliers get a
   public ID: a type prefix (cus_, sup_) and at least 16 characters of Crockford base32 from a cryptographically secure
   generator (no 0/O or 1/I confusion), for example cus_8F3K2M9Q7X4T1V6B; unique by a database constraint with a retry
   on collision, never reused, never edited; shown in responses and accepted in search. Owner's answer: it replaces the
   sequential customer number (C-00001) and the supplier's sequential number in the API from 2.0.0; their columns stay
   internally (master data is never hard-deleted). Backfill existing rows by migration. Readable codes stay as they are:
   document numbers (sequential and gap-free for tax), lot codes, animal tags, branch codes.
5. No ID is ever a key: every read is authorised, whatever identifier it is given. Any link sent to a customer (order
   tracking, the receipt, a document link) carries its own long random token. Test that knowing someone's public ID,
   SKU or UUID gets you nothing, per operation that takes one, as an anonymous caller and as another customer.
6. Contract 2.0.0: a loud changelog entry listing everything removed and added, the cold-read summary rewritten for
   2.0.0, and every example updated (the frontend's mock is served from these examples). Record the decisions as ADRs
   (accepted by the owner), superseding any earlier ADR that set the SKU as user input or the product barcode.
Write the failing test first for every rule. Mutation-check the generators' uniqueness and the "no ID is a key" refusals.
Stop at the gate, write docs/sessions/B09q-ids-barcodes.md, and merge into main when every run on the pull request is
green.
```

## B09q continued — No identifier is a key, and every customer link has its own random token

Branch `b09q2-no-id-is-a-key`, from `main`. Report `docs/sessions/B09q2-no-id-is-a-key.md`. Inserted by B09q's split (A-254, ADR-0026 Amendments) after B09q and before B09e: B09q built every shape change of contract 2.0.0 (the QR guard, no product barcode, server-generated SKUs, public IDs, ADR-0072, ADR-0073); this phase builds the owner's decision 5 of 2026-11-17 unchanged. Gate: knowing someone's public ID, a SKU or a UUID gets you nothing: every operation that takes one (in its path, query or body) refuses an anonymous caller and another customer, and a staff role without the permission or outside its branch, proved by a test per operation, with the refusals mutation-checked; every link sent to a customer (the order tracking link, the receipt link B9b builds, a document link) carries its own long random token, stored only as a hash, never derived from an id, proved by a test that a guessed, altered or another order's token reads nothing; no shape of contract 2.0.0 changes (a description or a minor addition at most), with its changelog entry.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09q-ids-barcodes.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decision 5 below, ADR-0073, ADR-0070 (the tracking token it replaces),
docs/security/SECURE_CODING_STANDARDS.md SC-02, the abuse cases on enumeration and on customer links in
docs/security/THREAT_MODEL.md, and test/integration/iam/authorisation.integration.spec.ts (the handler walk). Load
hakorem-security-review, hakorem-endpoint, hakorem-migration and hakorem-tests. Do not read any other document unless
this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09q continued only, on branch b09q2-no-id-is-a-key, branched from main. The owner's decision 5
(2026-11-17), as B09q's opener gave it:
5. No ID is ever a key: every read is authorised, whatever identifier it is given. Any link sent to a customer (order
   tracking, the receipt, a document link) carries its own long random token. Test that knowing someone's public ID,
   SKU or UUID gets you nothing, per operation that takes one, as an anonymous caller and as another customer.
In practice: list from the contract every implemented operation that takes a UUID, a public ID (`q` on listCustomers
and listSuppliers) or a SKU (`q` on listProducts, the import sheets) and write one generated test per operation that
calls it as an anonymous caller, as another customer and as a staff role without its permission, expecting 401, 404 or
403 as SC-02 says and nothing in the answer; a customer's own reads (getMyOrder and the like) answer 404 for another
customer's record. Replace trackOrder's HMAC-signed id token (ADR-0070) with a random token of at least 128 bits made
when the order is placed, stored only as its hash in ORD, looked up in constant time, never derived from the order id;
record the change as an ADR superseding that part of ADR-0070, and keep trackOrder's shape. Name, in the report, the
link B9b's receipt and B11's SMS must follow. Mutation-check the refusals (remove an authorisation and see the tests go
red). The contract stays 2.0.x: descriptions, examples and at most additive changes.
Stop at the gate, write docs/sessions/B09q2-no-id-is-a-key.md, and merge into main when every run on the pull request
is green.
```

## B09e — Eggs: prices per selling unit, cost without drift, crates and singles, cracked on arrival

Branch `b09e-eggs`, from `main`. Report `docs/sessions/B09e-eggs.md`. Inserted by the owner on 2026-11-17 after B09q (and, since B09q's split, B09q continued) and before B9b (ADR-0026 Amendments): the business starts with eggs bought from a supplier and resold, and the egg coverage check found gaps the till would meet on day one. Gate: a crate and a single egg each carry their own price on the price list, so GHS 55.00 a crate is possible, while stock stays in eggs; a delivery's total cost is spread across its eggs by largest-remainder allocation, never rounded egg by egg, and a crate bought at GHS 47.50 and sold whole posts cost of exactly 4,750 pesewas; receipts, orders and transfers take lines in crates or eggs, converted by the server; every bought lot has a received date and sells oldest first by expiry, then by received date; a rejected quantity carries its reason and a claim drafts the supplier credit note from the receipt; quantity breaks and reorder points are counted in the selling unit and stored in eggs; a purchase order line defaults to the last price paid to that supplier for that product; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09q2-no-id-is-a-key.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decisions below, ADR-0018 (valuation and cost accumulation), ADR-0048, A-157 and
B06u's report on unit conversions, docs/data-model/mdm.md, inv.md and pur.md, and the MDM, INV and PUR cards in
docs/MODULE_BOUNDARIES.md. Load hakorem-money, hakorem-pricing, hakorem-stock, hakorem-ledger, hakorem-migration,
hakorem-endpoint and hakorem-tests. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09e only, on branch b09e-eggs, branched from main. The owner's decisions (2026-11-17), each test-first
with exact pesewa assertions:
1. Price per selling unit: a crate and a single egg each carry their own price on the price list; never derive a
   crate's price from a per-egg price. Stock stays held in eggs. The engine resolves the price of the unit sold.
2. Cost without drift: keep each delivery's total cost and spread it across its eggs with largest-remainder allocation
   (the kernel's allocate, as the distributions do); never round cost egg by egg. A crate bought at GHS 47.50 and sold
   whole posts cost of exactly 4,750 pesewas; a crate broken into singles posts costs summing exactly to 4,750. Read
   ADR-0018 first: if lot-level exact cost contradicts its valuation method, STOP and report the options to the owner
   rather than building.
3. Lines in crates: goods receipts, orders and transfers accept a line in crates or in eggs, converted by the server
   through MasterDataRefs.toBaseIn (B06u), never with a factor of their own.
4. A received date on every bought lot; sell oldest first by expiry, then by received date, wherever the server picks a
   lot (promisable stock, reservations, checkout, and the sale when no lot is named).
5. Cracked on arrival: a reason on every rejected quantity (CRACKED, BROKEN, DIRTY, SHORT, as reason codes), and a
   claim raised from the receipt that drafts the supplier credit note from the rejected lines and their cost, instead
   of keying it by hand; the credit note keeps its existing approval (maker and checker apart).
6. Quantity breaks and reorder points counted in the selling unit (10 crates), stored in eggs.
7. A purchase order line defaults to the last price paid to that supplier for that product; no full supplier price
   list yet.
The frontend's CR-035 (breakage and rejection reasons) and CR-036 (a claim raised from a receipt's rejected lines) are
answered by points 5 and the breakage reasons above (owner, 2026-11-17): build them to the requests' shapes as committed
on the frontend's main, and answer both in the report.
Not in this phase: returnable trays and crates (BL-074, until the owner confirms); registered checkout and order
promotions (BL-072, BL-073). Kasoa and KNUST are real selling points the owner creates through the API: never seed them.
Additive contract changes only, unless one is unavoidable and recorded loudly.
Stop at the gate, write docs/sessions/B09e-eggs.md, and merge into main when every run on the pull request is green.
```

## B09e continued — Eggs: lines in crates, received dates and oldest first

Branch `b09e2-eggs-lines-lots`, from `main`. Report `docs/sessions/B09e2-eggs-lines-lots.md`. Inserted by B09e's split (A-262, ADR-0026 Amendments) after B09e and before B09e continued 2: B09e built prices per selling unit, the cost by place in the delivery (ADR-0075), breaks in the selling unit, the counter and online sale in crates and the seeded eggs counted per egg. Gate: goods receipts and stock transfers take a line in crates or eggs, converted by the server through MasterDataRefs.toBaseIn, never with a factor of their own (orders already do: B09e built createOrder, the sale posting and online placement in the unit sold); every bought lot has a received date and sells oldest first by expiry, then by received date, wherever the server picks a lot (promisable stock, reservations, checkout, and the sale when no lot is named); reorder points are counted in the selling unit and stored in eggs; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09e-eggs.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decisions 3, 4 and 6 below, ADR-0018 and ADR-0075, A-157, A-163 and A-259 to A-262,
docs/data-model/inv.md, mdm.md and ord.md, and the MDM, INV and ORD cards in docs/MODULE_BOUNDARIES.md. Load
hakorem-stock, hakorem-money, hakorem-migration, hakorem-endpoint and hakorem-tests. Do not read any other document
unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09e continued only, on branch b09e2-eggs-lines-lots, branched from main. The owner's decisions
(2026-11-17), each test-first with exact quantity and pesewa assertions:
3. Lines in crates: goods receipts (createGoodsReceipt and its lines) and stock transfers accept a line in crates or in
   eggs, converted by the server through MasterDataRefs.toBaseIn (B06u), never with a factor of their own; the line
   keeps the unit it was entered in, and stock moves in eggs. Orders already do (B09e: createOrder, its confirmation's
   reservations, the sale posting, online placement and returns). A purchase order line already converts (B7): a
   receipt against it in crates matches it.
4. A received date on every bought lot (the receipt's received_at, kept on the stock unit); sell oldest first by
   expiry, then by received date, wherever the server picks a lot: promisable stock, reservations, checkout, and the
   sale when no lot is named.
6. (The rest of it.) Reorder points, minimum and maximum levels counted in the selling unit (a reorder point of 30
   crates), stored in eggs; the alert and the suggested reorder answer in both.
The cost of each issue stays the database's (ADR-0075): a crate bought at GHS 47.50 still posts exactly 4,750.
Additive contract changes only, unless one is unavoidable and recorded loudly.
Stop at the gate, write docs/sessions/B09e2-eggs-lines-lots.md, and merge into main when every run on the pull
request is green.
```

## B09e continued 2 — Eggs: cracked on arrival, the claim, the last price paid

Branch `b09e3-eggs-claims`, from `main`. Report `docs/sessions/B09e3-eggs-claims.md`. Inserted by B09e's split (A-262, ADR-0026 Amendments) after B09e continued and before B9b. Gate: a rejected quantity carries its reason from the `GOODS_RECEIPT_REJECTION` domain (CRACKED, BROKEN, DIRTY, SHORT, WRONG_ITEM, QUALITY_REJECTED, A-260), refused without one and refused on nothing rejected; a claim raised from a posted receipt drafts the supplier credit note from the rejected lines and their cost, never keyed by hand, linked both ways, moving no stock, and keeps the credit note's approval with maker and checker apart; breakage reasons exist for stock adjustments; a purchase order line defaults to the last price paid to that supplier for that product; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09e2-eggs-lines-lots.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decisions 5 and 7 below, CR-035 and CR-036 as committed on the frontend's main,
ADR-0075, A-260, docs/data-model/inv.md, pur.md and mdm.md (the reason codes), and the INV and PUR cards in
docs/MODULE_BOUNDARIES.md. Load hakorem-money, hakorem-stock, hakorem-ledger, hakorem-migration, hakorem-endpoint,
hakorem-security-review and hakorem-tests. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09e continued 2 only, on branch b09e3-eggs-claims, branched from main. The owner's decisions
(2026-11-17), each test-first with exact pesewa assertions:
5. Cracked on arrival: a reason on every rejected quantity, from a new reason code domain GOODS_RECEIPT_REJECTION
   seeded with CRACKED, BROKEN, DIRTY, SHORT, WRONG_ITEM and QUALITY_REJECTED (A-260), each with requiresNote; the
   receipt line answers its reason and note (CR-035 points 2 and 3, with the codes A-260 names); STOCK_ADJUSTMENT
   breakage reasons (BREAKAGE and any the seed already names, CR-035 point 1); supplier scoring's rejection rate reads
   the same field (CR-035 point 4). A claim raised from the posted receipt drafts the supplier credit note from the
   rejected lines and their cost (from the purchase order line's price, split exactly with the kernel's allocate
   between accepted and rejected), never keyed by hand, linked both ways (the receipt answers its claims; the claim
   names its receipt, purchase order and the credit note or invoice that settles it), moving no stock, on the
   supplier's account until settled; the credit note keeps its existing approval, maker and checker apart,
   mutation-checked with test data where the maker, the receiver and the approver are different people (CR-036).
   Since B09e continued (A-263), a receipt line may be entered in crates: `qtyRejected` is counted in the line's `uom`
   and stored in the base unit (`qty_rejected`, `qtyRejectedBase`), so the claim's quantities and cost come from the
   base quantities, never from a factor of the claim's own.
7. A purchase order line defaults to the last price paid to that supplier for that product; no full supplier price
   list yet.
Answer CR-035 and CR-036 in the report. Every new read is authorised and joins the contract-generated identifier walk
(B09q continued). Additive contract changes only, unless one is unavoidable and recorded loudly.
Stop at the gate, write docs/sessions/B09e3-eggs-claims.md, and merge into main when every run on the pull request is
green.
```

## B09e continued 3 — Eggs: the claim from a receipt's rejected lines

Branch `b09e4-eggs-claim`, from `main`. Report `docs/sessions/B09e4-eggs-claim.md`. Inserted by B09e continued 2's split (A-271, ADR-0026 Amendments) after B09e continued 2 and before B9b: B09e continued 2 built the rejection reasons (a `GOODS_RECEIPT_REJECTION` reason on every rejected quantity, CR-035), the breakage adjustment reasons and the last price paid. Gate: a claim raised from a posted receipt with rejected lines drafts the supplier credit note from the rejected lines and their cost, the cost from the purchase order line's price split exactly with the kernel's allocate between accepted and rejected, never keyed by hand (a request that supplies an amount is refused); linked both ways (the receipt answers its claims; the claim names its receipt, purchase order and the credit note or invoice that settles it); moving no stock and posting nothing until the credit note is approved; on the supplier's account until settled; the credit note keeps its approval with maker and checker apart, mutation-checked; inflated rejections reach the exception report's source; every write refuses the wrong role and every new read is authorised and in the identifier walk.

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

## B9b — Point of sale, shifts and offline sync

Branch `b09b-pos-shifts-offline`. Report `docs/sessions/B09b-pos-shifts-offline.md`. Gate: shift close reconciles, and 500 queued offline transactions sync exactly once.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09e4-eggs-claim.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0015, ADR-0027, ADR-0074 (the receipt link's token) and the abuse cases 4, 10, 11 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b only, on branch b09b-pos-shifts-offline: registers and device enrolment, shifts with
the opening float, cash movements and cash drops, X and Z reports, blind close with supervisor sign-off
and over/short posting, held sales, the offline pack, and offline sync: exactly-once by client UUIDv7,
the gap-free device counter, provisional references, occurred-at and recorded-at, cash-only tenders
offline, the stock exception instead of a refusal, price override bounds re-checked at sync. Write
the five conflict tests ADR-0027 names (animal sold elsewhere, animal on hold, countable stock gone
negative, sale in a locked period, missing device counter) and the 500-transaction test with the network
disabled. Run scenario 6 of docs/UAT.md as a dry run and record any difference.
Check that counter sales reach the owner dashboard's sales figures and the getSalesTodayTile and getSalesSeries
tiles B9a made live (B05x, A-149): a seeded counter sale appears in today's sales by channel POS, test-first.
The owner's two additions to A-200 (2026-11-16), each test-first:
(1) An offline sale synced later is issued at its occurred_at, the time it happened at the till, not the sync time:
that is the real transaction time, not a backdate. Extend Billing.issueIn additively to take that time for a synced
sale only, mark the document as synced from offline (a field the receipt and the document read show), and bound how
old an offline sale may be (a setting, conservative default, recorded in ASSUMPTIONS.md): a sale outside the bound is
still recorded, never refused (a synced sale is always recorded), and reaches the exception report; a sale whose
period has since locked posts on the first open date, flagged, keeping its occurred_at (ADR-0027 point 6).
(2) A business buyer at the counter may have their name and TIN printed on the VAT invoice without opening a customer
account, so they can reclaim the input tax: optional buyer name and TIN on the counter sale and the billing document,
validated in format, printed on the invoice, and never creating a customer; the walk-in party stays.
The owner, 2026-11-16 (A-212 (a)): cash enters only through a till shift. Build a customer paying an invoice at the till
inside the shift, counted at close, and refuse any cash payment outside an open shift, test-first.
The frontend's CR-031 and CR-032 (planned in contract 1.45.0 by B09a continued 1d): fill OfflineProduct.taxInclusive
from each product's price list, SyncResultItem.grossPesewas (null when nothing was recorded) and its currency, and the
pack's CASH_MOVEMENT reason codes; decide CR-032 point 2, the offline PIN verifier (an operation that sets a till
PIN and the salted verifier the device stores, or a statement in OFFLINE_SYNC.md that the device derives it from the
PIN typed at an online sign-in), record it as an ADR and answer it in the report.
The owner's rules for the till PIN (CR-032, 2026-11-17), which the frontend already enforces on the device and the server
must match, each test-first: a PIN verifier is PBKDF2-SHA256 with at least 600,000 iterations and a random salt of at
least 16 bytes per person, never weaker (refuse a weaker verifier, and test the parameters); at most five wrong tries,
enforced on the server too (counted at sync for offline attempts and at any online check, then locked); signing out a
locked cashier requires a supervisor's PIN, is audited, and reaches the daily exception report's source (B12). The PIN
never authenticates to the server and is never the only control (CR-032 point 5).
CR-033 points 1 and 2 (owner's rule, 2026-11-16: every sale produces a digital receipt, by SMS or a link, and a printer
is optional): a public receipt read with no session, by an unguessable token, answering the official number, the sale
reference, the lines, the tenders, the change and the business's details (read through AUD's `BusinessProfiles`, B09x continued), and "being recorded" until the sale has
synced. No QR code (owner, 2026-11-17: the TOTP enrolment QR is the only QR in the system): the link reaches the
customer by SMS. The token is its own long random value (owner, 2026-11-17: no ID is ever a key), generated by the till
from a cryptographically secure source when the sale is made, so the link exists offline, and sent with the sale at
sync; never the sale's client id. Record the choice as an ADR with hakorem-security-review. Rate-limit the read, expose
no other customer's data, and test that a guessed token, another sale's token or the sale's own id answers 404. The SMS on sync (point 3) is B11's.
The receipt token (owner, 2026-11-17, ADR-0074 Amendments): at least 128 random bits from a secure generator (the `rcp_`
token's 32 bytes meet it), base64url, made by the till offline and sent with the sale at sync; the server stores only
its hash, unique, valid for 12 months, and revocable. The public receipt read takes the token and nothing else. Test
that a sale UUID, a document number or a SKU opens no receipt, and that a token reused for a second sale is refused at
sync (the second sale is still recorded; only its link is refused, and the refusal reaches the exception source).
A reused token (owner, 2026-11-17): a 128-bit token cannot repeat by chance, so every reuse goes to the exception
report's source as a possible till fault or tampering, naming the device, the shift, the cashier and both sales,
whatever the reason; and the second sale is marked as needing a fresh server-made link, which B11's receipt SMS sends
(ADR-0074: a link sent by message gets its own token from the worker, never stored in clear). Test that the reuse
reaches the exception source exactly once per refused sale, and that a replayed sync adds no second entry. If the
sale carried no customer phone, say how the customer still gets a working receipt, the most conservative choice
recorded as an assumption.
CR-038 (owner, 2026-11-17, F10f): the till sells a product in more than one unit, each at its own price (a crate and a
single egg): OfflineProduct.sellingUnits, one entry per unit sold at the register, saleUom first, each priced by its own
entry and never derived from another unit's price; CounterSaleLine.uom (absent means saleUom), converted to the base unit
for stock through MasterDataRefs.toBaseIn and re-priced by that unit's entry at sync; a unit the product is not sold by is
VALIDATION_FAILED on /lines/{i}/uom; a return refunds in the unit sold. Test-first with exact pesewas, at a crate and a
single egg of the seeded eggs, online and offline.
Stop at the gate and write docs/sessions/B09b-pos-shifts-offline.md.
```

## B09b continued — Devices, the counter sale, the force close and held sales

Branch `b09b2-pos-devices-counter`. Report `docs/sessions/B09b2-pos-devices-counter.md`. Gate: a device is enrolled and revoked; a counter sale is taken on the cashier's own open shift, change from cash only; a cash refund only out of an open shift. **Split (A-274, ADR-0026 Amendments):** the force close, held sales, a cleared provider payment as a counter tender and the audit anchor at each sign-off moved to B09b continued 1b.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b-pos-shifts-offline.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0016 (the device credential), ADR-0027, A-273 in docs/ASSUMPTIONS.md, and the abuse cases 1, 3, 4 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued only, on branch b09b2-pos-devices-counter, branched from main: device enrolment
(enrolDevice, listRegisterDevices, revokeDevice: a credential shown once and stored hashed, revocable, Register.deviceCount
true); completeCounterSale (POST /pos/sales, x-owner-module ord) through ORD's SalePosting.postIn on the seller's own
OPEN shift locked for the sale, with the device credential the contract names, change from cash only (the domain's
changeDue), the per-shift price override limit (FR-POS-004), a mobile money or card tender only as a payment already
initiated and cleared by the provider (FR-POS-006), and the refusal of any cash outside an open shift, test-first;
forceCloseShift (a manager, a reason, the shift closed at its expected cash, audited, seeding pos.shift.force_close,
the variance posted when the drawer is counted later); held sales (holdSale, listHeldSales, recallHeldSale, re-priced on
recall, lapsing at close); a cash refund paid only out of an open shift of the till that took the payment (A-273 (i));
the audit chain anchored at each sign-off through the worker. Every write gets its wrong-role refusal test; every new
read joins the identifier walk. Maker and checker never the same user, mutation-checked.
A cash drop's witness (owner, 2026-11-17, A-273 (d)): a supervisor when one is signed in at that branch; when none is,
the drop is allowed unwitnessed, marked as unwitnessed (a field the drop and the X and Z reports show), and put on the
daily exception report's source. A one-person shop is never forced to keep cash in the drawer; the safe and bank
deposit counts are the check. Test both, and that a drop with a supervisor signed in still needs the witness.
Stop at the gate and write docs/sessions/B09b2-pos-devices-counter.md.
```

## B09b continued 1b — The force close, held sales, the counter's provider tender and the audit anchor

Branch `b09b2b-pos-force-close-held`. Report `docs/sessions/B09b2b-pos-force-close-held.md`. Gate: a force close by a manager who is not the cashier, closed at its expected cash and its variance posted when the drawer is counted, mutation-checked; held sales re-priced on recall with exact pesewas, lapsing at close; a mobile money or card tender at the counter only as a payment the provider cleared, never allocated twice nor another customer's.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b2-pos-devices-counter.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md (sections 2, 6.5, 9.4.2 and 11),
ADR-0016, ADR-0027, ADR-0077, A-273 and A-274 in docs/ASSUMPTIONS.md, and the abuse cases 1, 3, 4 and 17 in
docs/security/THREAT_MODEL.md. Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it. Lane A (docs/prompts/session-openers.md, "Two lanes").

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 1b only, on branch b09b2b-pos-force-close-held, branched from main: forceCloseShift
(pos.shift.force_close, seeded by B09b continued with step-up; a manager who is not the cashier, a reason, the shift
closed at its expected cash and flagged force-closed, audited; the variance posted when the drawer is counted later;
held at the database that the checker is never the cashier; mutation-checked), and prove that cash naming a
force-closed shift is refused on every cash path of ADR-0077 with the real operation (test/integration/pos/
till-cash-paths.integration.spec.ts simulates it today); held sales (holdSale, listHeldSales, recallHeldSale on the
till's open shift, pos.held_sale, re-priced on recall with exact pesewas after a price change between hold and recall,
recalled once, lapsing at the shift's close); a mobile money or card tender at the counter as a payment the provider
already cleared (TenderInput.paymentId, FR-POS-006): the payment must be linked to its sale so ORD's reads and a void
see it (A-274 (f): the cleared payment is frozen, so decide the link with an ADR and ask the parent session before
changing an existing PAY or ORD shape), allocated once, never another customer's or another shift's, test-first with
exact pesewas; the audit chain anchored at each sign-off through the worker (approveShiftClose's description promises
it). Every write gets its wrong-role refusal test; every new read joins the identifier walk.
ADR-0077 (accepted by the owner, 2026-11-18, on condition): re-prove every row of its Verification table's force-closed
column against a shift force-closed through forceCloseShift itself, test-first, and name each test in the table. If
any path accepts cash on a force-closed shift, stop and report: the ADR returns to Proposed.
Stop at the gate and write docs/sessions/B09b2b-pos-force-close-held.md.
```

## B09b continued 2 — The offline pack and offline sync

Branch `b09b3-pos-offline-sync`. Report `docs/sessions/B09b3-pos-offline-sync.md`. Gate: 500 queued offline transactions sync exactly once, and ADR-0027's five conflict tests pass.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b2b-pos-force-close-held.md).
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

## B09b continued 3 — The till PIN

Branch `b09b4-pos-till-pin`. Report `docs/sessions/B09b4-pos-till-pin.md`. Gate: the till PIN's verifier, attempt limit and supervisor sign-out as the owner set them (CR-032), each test-first.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b3-pos-offline-sync.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0016, ADR-0027, and the abuse cases 4, 10 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 3 only, on branch b09b4-pos-till-pin, branched from main: decide CR-032 point 2, the
offline PIN verifier (an operation that sets a till PIN and the salted verifier the device stores, or a statement in
OFFLINE_SYNC.md that the device derives it from the PIN typed at an online sign-in), record it as an ADR and answer it in
the report. The owner's rules for the till PIN (CR-032, 2026-11-17), which the frontend already enforces on the device
and the server must match, each test-first: a PIN verifier is PBKDF2-SHA256 with at least 600,000 iterations and a
random salt of at least 16 bytes per person, never weaker (refuse a weaker verifier, and test the parameters); at most
five wrong tries, enforced on the server too (counted at sync for offline attempts and at any online check, then
locked); signing out a locked cashier requires a supervisor's PIN, is audited, and reaches the daily exception report's
source (B12). The PIN never authenticates to the server and is never the only control (CR-032 point 5). An approval made
offline records which PIN approved it (CR-032 point 4) and is verified at sync. Load hakorem-security-review and write
its finding into the pull request body.
Stop at the gate and write docs/sessions/B09b4-pos-till-pin.md.
```

## B09b continued 4 — The receipt link, the business buyer's TIN and an invoice paid at the till

Branch `b09b5-pos-receipts`. Report `docs/sessions/B09b5-pos-receipts.md`. Gate: the public receipt read by its token alone; a reused token recorded and refused once per sale; the buyer's TIN on the VAT invoice; an invoice paid at the till inside the shift.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b4-pos-till-pin.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0074 (the receipt link's token) and its Amendments, and the abuse cases 4, 10, 11 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 4 only, on branch b09b5-pos-receipts, branched from main.
The owner's addition (2) to A-200 (2026-11-16), test-first: a business buyer at the counter may have their name and TIN
printed on the VAT invoice without opening a customer account, so they can reclaim the input tax: optional buyer name
and TIN on the counter sale and the billing document, validated in format, printed on the invoice, and never creating a
customer; the walk-in party stays.
The owner, 2026-11-16 (A-212 (a)): cash enters only through a till shift. Build a customer paying an invoice at the till
inside the shift, counted at close, and refuse any cash payment outside an open shift, test-first.
CR-033 points 1 and 2 (owner's rule, 2026-11-16: every sale produces a digital receipt, by SMS or a link, and a printer
is optional): a public receipt read with no session, by an unguessable token, answering the official number, the sale
reference, the lines, the tenders, the change and the business's details (read through AUD's `BusinessProfiles`, B09x continued), and "being recorded" until the sale has
synced. No QR code (owner, 2026-11-17: the TOTP enrolment QR is the only QR in the system): the link reaches the
customer by SMS. The token is its own long random value (owner, 2026-11-17: no ID is ever a key), generated by the till
from a cryptographically secure source when the sale is made, so the link exists offline, and sent with the sale at
sync; never the sale's client id. Record the choice as an ADR with hakorem-security-review. Rate-limit the read, expose
no other customer's data, and test that a guessed token, another sale's token or the sale's own id answers 404. The SMS on sync (point 3) is B11's.
The receipt token (owner, 2026-11-17, ADR-0074 Amendments): at least 128 random bits from a secure generator (the `rcp_`
token's 32 bytes meet it), base64url, made by the till offline and sent with the sale at sync; the server stores only
its hash, unique, valid for 12 months, and revocable. The public receipt read takes the token and nothing else. Test
that a sale UUID, a document number or a SKU opens no receipt, and that a token reused for a second sale is refused at
sync (the second sale is still recorded; only its link is refused, and the refusal reaches the exception source).
A reused token (owner, 2026-11-17): a 128-bit token cannot repeat by chance, so every reuse goes to the exception
report's source as a possible till fault or tampering, naming the device, the shift, the cashier and both sales,
whatever the reason; and the second sale is marked as needing a fresh server-made link, which B11's receipt SMS sends
(ADR-0074: a link sent by message gets its own token from the worker, never stored in clear). Test that the reuse
reaches the exception source exactly once per refused sale, and that a replayed sync adds no second entry. If the
sale carried no customer phone, say how the customer still gets a working receipt, the most conservative choice
recorded as an assumption. The thermal receipt (FR-POS-021) is the counter sale's escPosBase64.
Stop at the gate and write docs/sessions/B09b5-pos-receipts.md.
```

## B09c — Card payment

Branch `b09c-card-payment`, from `main`. Report `docs/sessions/B09c-card-payment.md`. Inserted by the owner on 2026-11-17 right after B9b and before B10 (ADR-0026 Amendments). Gate: an online order can be paid by card through the Paystack provider port with every edge case B09a continued proved for mobile money (timeout after charge, webhook before response, duplicate webhook, unknown reference, amount mismatch on re-verification, late webhook, refund, and the refund idempotency the sandbox exposed, A-218), a card payment's card details never touch our servers or logs, and the on-demand sandbox suite (`pnpm test:sandbox`) runs the card cases against the real Paystack sandbox with the owner's test key, reporting any difference from the documentation.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09b5-pos-receipts.md, the last of B9b's
splits, A-273 (a)).
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

## B08 continued 2d — Customer statements

Branch `b08c2d-customer-statements`, from `main`. Report `docs/sessions/B08c2d-customer-statements.md`. Inserted by B08 continued 2c's split (A-206, ADR-0026 Amendments), and placed after B9b by the parent session (A-207): a statement nets payments, which PAY builds in B9a, and its home module WHL is B10's. Gate: a customer statement for a period lists the customer's issued documents and their settlement, ties to the ledger's 1200 for that customer's subledger party and period (opening plus invoices and debit notes less credit notes and payments equals closing, to the pesewa, asserted against SQL sums taken straight from `bil.billing_document` and `fin.journal_line`), is numbered from its own gap-free series, rendered after commit and archived exactly once; every statement write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report on main (lane B's first phase starts beside lane A, owner
2026-11-17; see "Two lanes" below), and docs/sessions/B09b-pos-shifts-offline.md for the till's cash rules.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-WHL-009 and the DOC requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/whl.md (`whl.statement`), doc.md and bil.md, the WHL, BIL, DOC and FIN cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0011, ADR-0015, ADR-0056, ADR-0060, ADR-0061 and ADR-0062. Read A-200,
A-204 and A-206 in docs/ASSUMPTIONS.md. Load hakorem-module, hakorem-migration, hakorem-ledger, hakorem-money,
hakorem-documents, hakorem-endpoint and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 2d only, on branch b08c2d-customer-statements, branched from main: the WHL module with
customer statements only (`whl.statement`, the `STATEMENT` document type and its series, the permissions
`whl.statement.read` and `whl.statement.create` and their grants, listStatements, createStatement and getStatement,
the A4 statement template with sample data, rendered and archived through Documents.requestRenderIn and linked by a
consumer of doc.DocumentArchived). Decide with an ADR where the figures come from: WHL's card imports no FIN today,
and an opening balance entered by manual journal against a customer is on 1200 but on no billing document, so the
recommended reading is the customer's 1200 activity by subledger party through FIN's door, each line named by its
source document, which also brings in B9a's payments without a change. Write the statement arithmetic test first,
including FR-WHL-009's case (opening 100,000, invoices 250,000, credit note 20,000, payment 150,000, closing 180,000)
and a customer in credit. sendStatement stays planned for B11 (ADR-0062). Extend the seed with one statement.
Stop at the gate, write docs/sessions/B08c2d-customer-statements.md, and merge into main when every run on the pull
request is green. End the report with B09u's opening message (lane B, owner 2026-11-17).
```

## B09u — Unit names, the egg base unit and the supplier account

Branch `b09u-units-supplier-account`, from `main`. Report `docs/sessions/B09u-units-supplier-account.md`. Lane B, after B08 continued 2d and before B10 (owner, 2026-11-17, F10g and F10h: the unit names and CR-040 move here from B09c, "the next phase of either lane"). Gate: every unit answers a singular and a plural name and the seeded eggs are counted in a unit named "egg" with every stored figure unchanged; a receipt line against an order line is valued by the server unless a value is typed; a supplier credit note raised by the Owner and drafted by the Accountant can be approved by a Manager, and never by either of them; a supplier's balance answers from the server; approving a supplier invoice refuses its maker; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md, and "Two lanes" below.
List docs/sessions/ and read only the most recent report of lane B (docs/sessions/B08c2d-customer-statements.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), CR-040 and CR-042 to CR-044.
For this phase, read docs/data-model/mdm.md (units and conversions), pur.md and inv.md, the MDM, PUR, INV and IAM
cards in docs/MODULE_BOUNDARIES.md, ADR-0001, ADR-0035, ADR-0075 and ADR-0076, A-260 to A-272, and the role matrix.
Load hakorem-money, hakorem-migration, hakorem-endpoint, hakorem-seed, hakorem-security-review and hakorem-tests.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09u only, on branch b09u-units-supplier-account, branched from main. The owner's decisions
(2026-11-17), each test-first, additive contract changes only unless one says otherwise:
Also in this phase (owner, 2026-11-17, F10f), each test-first, additive contract changes only:
1. Unit names. Every unit answers a singular and a plural name in the contract (for example "egg" and "eggs",
   "crate" and "crates"), so screens can say "540 eggs" and "from 10 crates". The seeded eggs' base unit is named
   "egg": the egg products are counted in an egg unit, not the generic unit, with every stored quantity and price
   unchanged (900 eggs are still 900, a crate still 30 of them). Update the seed and every example, the mock's
   included. If renaming the base unit would change a stored figure or an existing shape, stop and report.
2. CR-040. A goods receipt line that names purchaseOrderLineId may leave out valuePesewas: the server values it from
   the order line for the accepted quantity, rounded half-up once (ADR-0001, ADR-0075's arithmetic untouched), and the
   receipt's answer shows it; a typed value always wins. A line with no order line still requires it. The contract
   no longer both requires the field and says it defaults. Test at a price that does not divide evenly.
3. Supplier credit notes (F10g): an Owner or a Manager approves a supplier credit note, as with customer credit
   notes, never the person who raised the claim or drafted the credit note. Today the seeded roles leave nobody able
   to approve one the Owner raised and the Accountant drafted: fix the role matrix (grant the Manager the approval,
   one additive grant; IAM is lane A's module, and this grant is the parent session's leave) and test that exact case
   (the Owner raises the claim, the Accountant drafts the credit note, a Manager approves it; the Owner and the
   Accountant are each refused), mutation-checked.
4. CR-042: getSupplierBalance (GET /suppliers/{id}/balance, pur.supplier_invoice.read) answering SupplierBalance as
   the request names it: owed, awaiting approval, claimed, in payment and paid, integer pesewas, never negative,
   within the branches the caller holds the permission at; each figure asserted against SQL sums taken straight from
   PUR's tables, never from the function under test. The read is authorised and joins the identifier walk.
5. CR-043: approveSupplierInvoice refuses the invoice's maker with 422 INVOICE_MAKER_CANNOT_APPROVE, in the domain and
   the database, as a credit note's approval does; the code joins the operation's x-error-codes. Approved by the owner
   (2026-11-17) as a breaking-behaviour change: mark it LOUD in docs/CONTRACT_CHANGELOG.md, and fix every seed and test that approves its own invoice.
6. CR-044: descriptions only. Say which unit SupplierInvoiceLine.qtyVariance is in and its sign, and that
   priceVariancePesewas is the line's whole difference from the order price, with priceVarianceDirection over or
   under. Check the listSupplierInvoices example against the arithmetic.
7. BL-077 (a defect, not parked work): approving the void of a sale whose payment already has a reversal waiting
   answers 500, because Receipts.reverseApprovedIn writes a second open reversal for the payment. Refuse the approval
   with a stated 422 code while a reversal is pending (and a reversal while a void is pending), in the domain and the
   database, test-first with the exact case B09b continued found (test/integration/pos/till-cash-paths), mutation-checked.
   ORD's void is lane B's; PAY's reversal is shared, so the change there is additive or recorded loudly.
8. The sheet import creates customers and suppliers without the advisory lock createCustomer and createSupplier now
   take (PR #102); take the same lock there, and test a concurrent import beside a create.
Stop at the gate, write docs/sessions/B09u-units-supplier-account.md, and merge into main through the merge slot when
every run on the pull request is green. End the report with B10's opening message.
```

## B10 — Quotations, wholesale and credit control

Branch `b10-quotations-wholesale`. Report `docs/sessions/B10-quotations-wholesale.md`. Gate: quote revisions are versioned, conversion to invoice preserves every link, and a credit limit blocks with an audited override.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09u-units-supplier-account.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the QUO and WHL requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/quo.md and whl.md, the QUO and WHL cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL
section 5.12, and ADR-0004, ADR-0017, ADR-0019 (quote reservations) and ADR-0085 (statements), and the abuse case 14 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B10 only, on branch b10-quotations-wholesale: requests for quote, quotes made of immutable
versions with the margin floor and its approval, reservations for the validity period, acceptance once
through the signed expiring link, conversion to exactly one order with every link kept, business
accounts with credit limit, terms and exposure, the credit override with a different approver, ageing
computed from invoice due dates, dunning, standing orders, overdue hold. Customer statements are built (B08 continued
2d, ADR-0085, A-300): add FR-WHL-009's ageing summary to them additively, and decide whether money held on deposit for
the customer (2200) belongs on them (A-300 (i)); sendStatement stays B11's. Run scenario 2
of docs/UAT.md as a dry run and record any difference, including the two rules that scenario flags
for the owner (credit check and delivery fee on a partial dispatch).
The owner, 2026-11-16 (A-212 (d)): a bounced cheque (a reversal with CHEQUE_DISHONOURED) counts against the customer's
credit standing.
CR-041 (owner, 2026-11-17, F10f): who holds a buyer's price list. getCustomerPriceList (GET
/customers/{id}/price-list, mdm.customer.read): the buyer's assignments, current and future; listPriceListAssignments
(GET /price-lists/{id}/assignments): the buyers who hold a list, with their windows; and PriceListEntry.baseUom, the
unit minQtyBase is in. Both reads are authorised and join the contract-generated identifier walk (B09q continued).
The owner, 2026-11-17, from the frontend's F10i (answer CR-045 to CR-047 in the report as committed on the frontend's
main; if one is not there yet, build from these words and say so), each test-first:
1. CR-045: a quote line names its unit (a crate or a single egg), priced by that unit's own entry, never derived from
   another unit's price; converted to the base unit through MasterDataRefs.toBaseIn for the reservation.
2. CR-046: an order over the customer's credit limit or past their terms does not go through. An approval request in
   place of a plain refusal is kept, but the response carries the amount over the limit and the reason (over limit,
   past terms, or both), the order stays blocked until approved, the override needs a written reason, and the
   approver is never the person who asked (mutation-checked). Exact pesewas at the limit, one pesewa over, and past
   terms by one day.
3. CR-047: the quote link carries its own long random token (ADR-0074: at least 128 bits, stored only as its hash,
   with an expiry), never the quote's id or number, with clear states the public read answers: expired, replaced (a
   newer version), accepted and declined. Accepted once only, by the token of the live version; test that a replaced
   version's token, an expired one, a guessed one and the quote id each open nothing.
4. The public request-for-quote form takes a quantity and its unit (crate or single egg), validated against the
   units the product is sold by.
5. Roles, in the role matrix and the seed: Sales builds, sends and converts quotes; the Accountant may put an account
   on hold; releasing a hold, approving a credit override and changing a credit limit are Owner or Manager only, and
   never by the person who asked. A wrong-role refusal test for each, and a maker-is-checker refusal for each of the
   three, mutation-checked.
Stop at the gate and write docs/sessions/B10-quotations-wholesale.md.
```

## B11 — Order fulfilment, delivery and notifications

Branch `b11-fulfilment-delivery`. Report `docs/sessions/B11-fulfilment-delivery.md`. Gate: a catch-weight order re-prices at pick, cash on delivery lands against the driver, and the outbox guarantees the customer notification.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B10-quotations-wholesale.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (fulfilment), DEL and NTF requirement blocks of docs/SRS.md (nothing else
from the SRS), docs/data-model/ord.md, del.md and ntf.md, the ORD, DEL and NTF cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0021, ADR-0026 (the abandoned-cart assignment), ADR-0074 (a link
sent by message gets its own token from the sending worker, never one stored in the outbox) and the abuse case 6 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 only, on branch b11-fulfilment-delivery: pick lists and picking with weight capture,
catch-weight re-pricing and customer consent beyond tolerance, packing, dispatch with the invoice on the
weighed quantity, partial fulfilment and backorders, substitutions, cancellation after confirmation,
delivery slot capacity and booking, zone cut-offs and rescheduling (the slot table and generation
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
Stop at the gate and write docs/sessions/B11-fulfilment-delivery.md.
```

## B12 — Capital, costing, reporting and the public API, and the daily exception report

Branch `b12-capital-costing-reporting`. Report `docs/sessions/B12-capital-costing-reporting.md`. Gate: a distribution matches a hand calculation on unit-days and ties exactly to the ledger.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read the last report of each lane (docs/sessions/B11-fulfilment-delivery.md and
docs/sessions/B09c-card-payment.md, or the last report of either lane's own splits); B12 opens only when both lanes
have merged (owner, 2026-11-17).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the CAP, CST, RPT and API requirement blocks of docs/SRS.md (nothing else from
the SRS), docs/data-model/cap.md, cst.md, rpt.md and api.md, the CAP, CST, RPT and API cards in
docs/MODULE_BOUNDARIES.md, and ADR-0018, ADR-0023, ADR-0028 and ADR-0026 (the daily
exception report), and section 4 of docs/security/THREAT_MODEL.md (the eighteen abuse cases and the
exception kind each names). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 only, on branch b12-capital-costing-reporting: investors, capital contributions and
withdrawals with approval, unit holdings with effective dates, distribution runs by unit-days with
largest-remainder allocation, the lifecycle draft to paid with step-up approval, loans and grants,
overhead allocation, cost object summaries, margin and loss facts, the reporting read model with its
projections and checkpoints, report definitions and schedules, the investor portal's read model, the
public API with keys and webhooks, and, as ADR-0026 proposes, the daily exception report:
GET /exceptions/daily-report, with an item kind for every one of the eighteen abuse cases, each item
carrying its abuse case numbers, actor, amount and subject document, so that B13 can assert it.
The exception report must include order splitting (abuse case 27, owner 2026-11-15, A-168): read
PUR's PurchaseOrders.splitSuspectsIn for the report's day and report each run with its maker, supplier,
orders and total; and the payout changes of case 13 from pur.SupplierPayoutChangeRequested and
pur.SupplierPayoutChanged, with SA-17's payment within 24 hours after a change.
It must include case 28 (B07 continued 1b, A-172): each invoice paid on an approved variance
(pur.SupplierInvoiceMatched or ExpenseInvoiceApproved with varianceApprovalRequestId) and each approved supplier
credit note (pur.SupplierCreditNoteApproved with its returned movements), with maker, approver and amount.
It must include PAY's breaks and reversals (the owner, 2026-11-16, B09a continued 1b): every reconciliation break of
every kind (from the provider sweep, from webhooks, from settlement and bank statement matching, and REFUND_FAILED)
read through the published view pay.pub_reconciliation_break, each with its kind, payment or reference, amount, age
and state; every payment mismatch found against Paystack among them; and each pay.PaymentReversalRequested (abuse
case 32) with its maker, amount and reason, beside pay.RefundRequested (case 12) and pay.WebhookRejected (case 5).
It must include case 2's reused death photographs (B06r, A-175): each liv.MortalityPhotoReused with the record,
the reporter and the earlier records whose photograph had the same bytes; and case 29 (A-176): every processing
reversal from prc.ProcessingOrderReversed with its value, the threshold copied onto it, the maker, the approver
when one was needed, and the reason. Residual risk R18 (B07 continued 2): count the storefront checkouts
started and expired per address a day from shp.CheckoutStarted and shp.CheckoutExpired, as an item when one
address holds stock repeatedly without placing an order.
It must include case 34, inflated rejections at the door (B09e continued 3, A-272, ADR-0076): a RECEIPT_CLAIM item for
each pur.SupplierClaimRaised, with the receipt, the receiver, the claim's maker, the supplier, the rejected quantity,
its reason and its value. And every exception source B9b, B09c and B11 add (their reports name each one), at least
each reused till receipt token (a possible till fault or tampering, owner 2026-11-17) and each supervisor's PIN
sign-out of a locked cashier (CR-032).
Write the five tests of ADR-0028 under the names the ADR gives them, and run scenario 4 of
docs/UAT.md as a dry run: the net profit for July to September 2026 in the seed is GHS 41,666.70 and
the hand calculation must match the run to the pesewa.
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): put the distribution rules under
src/modules/cap/domain/distribution/ and uncomment its 100 percent gate in vitest.config.mts before
the gate passes. Fill every branch it exposes; the gate does not pass on a lowered number.
The owner dashboard was pulled forward to B05x (A-149): keep getOwnerDashboard's shape, add its caching and the
NFR-023 performance budget, move its reads onto the hk_report connection, and remove `alerts` and
`exceptionsToday` from RPT's PENDING_FIGURES once the daily exception report answers them. runReport must implement
every report code listReportDefinitions lists, SALES_SUMMARY and PURCHASES included (CR-018), each matching its
contract example's columns.
The owner, 2026-11-16 (A-212 (a)): investor capital arrives through the investor module to the bank, never as cash.
Stop at the gate and write docs/sessions/B12-capital-costing-reporting.md.
```

## B09r — The reconciliation rules rewritten against the real files

Branch `b09r-reconciliation-real-files`, from `main`. Report `docs/sessions/B09r-reconciliation-real-files.md`. Inserted by the owner on 2026-11-16 (ADR-0065, A-214). It runs as soon as both real files exist, and before B13 at the latest: the owner supplies one real statement export from the farm's bank, and one real Paystack settlement covering real payments is available through the Settlements API. Gate: the settlement is read from Paystack's Settlements API, not a CSV export; the bank statement parser reads the bank's real export format; every format and matching rule names the file it came from, in ADR-0065 and in the test that holds it; fixtures replicate each real file's layout and quirks with invented values, and no real file or production value is committed; B09a continued 1c's database rules (a matched line posts once, ties never auto-match, idempotent import, a break resolves only through an approved posting) still hold; ADR-0065 is ready for the owner and the Accountant to accept.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read ADR-0065 (its "Evidence required" section first), A-214, docs/data-model/pay.md, the PAY card in
docs/MODULE_BOUNDARIES.md, B09a continued 2's report on the Settlements API, and the two real files the owner provides
(read them where the owner puts them; never copy them into the repository). Load hakorem-ledger, hakorem-money,
hakorem-migration, hakorem-seed, hakorem-security-review and hakorem-tests.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09r only: replace the settlement CSV import with a scheduled pull from Paystack's Settlements API
(idempotent by settlement id, the transactions matched by our reference), keeping the import endpoint only if the
owner asks; rewrite the bank statement parser against the bank's real export (header rows, date and amount formats,
debit and credit columns, references in the narration, charges, reversals); rewrite each matching rule against what
the files actually contain, test-first, each test naming its source file; invented fixtures only. Any rule the files
cannot settle goes to the owner as a question, never a guess.
Stop at the gate, write docs/sessions/B09r-reconciliation-real-files.md, and merge into main when every run on the pull
request is green.
```

## B13 — Hardening, smoke suite and deploy

Branch `b13-hardening-deploy`. Report `docs/sessions/B13-hardening-deploy.md`. Gate: every non-functional target met and evidenced on the live server, and the smoke suite's real Paystack sandbox payment delivered by webhook to the deployed endpoint posts exactly once.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B13 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12-capital-costing-reporting.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, also read the non-functional requirements table in docs/SHARED_BRIEF.md,
docs/security/THREAT_MODEL.md sections 4 and 5, docs/UAT.md, docs/OPERATIONS.md, docs/DEPLOYMENT.md,
docs/TEST_STRATEGY.md and ADR-0025, and docs/security/COMPLIANCE.md. Do not read any other document
unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
In the security review, treat residual risk R16 in docs/security/THREAT_MODEL.md: price lookup reads
wholesale and contract prices without branch or location scope (ADR-0036); decide with the owner between
scoping lookups to what the caller's role may sell and auditing bulk price reads, and test the choice.
Then execute B13 only, on branch b13-hardening-deploy: load tests with k6 against every target in the
non-functional table, with the actual numbers recorded in docs/OPERATIONS.md; every one of the eighteen
abuse cases turned into two tests, one that the control blocks or makes it visible and one that the
attempt appears on GET /exceptions/daily-report under the kind the threat model names, with the actor,
amount, subject document and its case number in abuseCases (a case that is blocked but absent from the
report is a failing test); the OWASP ZAP baseline against staging; the smoke suite under 60 seconds;
the smoke suite on the deployed server includes one real Paystack sandbox payment whose webhook Paystack delivers to
the live webhook endpoint and which posts exactly once (owner, 2026-11-16): one payment, one journal, the order paid,
and a redelivery of the same webhook posting nothing; it runs on the deployed staging server with the Paystack test
key (never a live charge; the live key is configured at deployment and never used by a test), and it is the one
check of real webhook delivery, which B09a continued 2's sandbox suite cannot make from a container;
the runbooks, one per failure mode; data migration with a dry-run mode; retention jobs and data-subject
requests, as ADR-0026 proposes; provisioning of staging and production; and the restore drill with the
time actually taken. Then run the seven scenarios of docs/UAT.md against staging, with someone
non-technical driving wherever that is possible: anything they cannot complete without a developer is
not finished.
Stop at the gate and write docs/sessions/B13-hardening-deploy.md.
```

---

## Two lanes (owner, 2026-11-17)

From 2026-11-17 the remaining phases before B12 run in two lanes at once, each in its own worktree and branch.

- **Lane A:** the rest of B9b (B09b continued to B09b continued 4, and any split of them), then B09c.
- **Lane B:** B08 continued 2d, then B09u, then B10, then B11 (and any split of them). B08 continued 2d moves into lane B because
  B10 reads its report and it needs only PAY's payments (B9a) and WHL, which lane B opens.
- **B12, then B13, start only when both lanes have merged.** B09r still waits for the owner's real files.

The rules, which add to everything else in this file and in CLAUDE.md (test first, stop conditions, merge on green,
never re-run red without naming the cause):

1. **Neither lane touches the other's modules.**
   - Lane A owns POS, IAM and PAY's card provider.
   - Lane B owns WHL, QUO, ORD, SHP, DEL, NTF and CST.
   - Shared modules may be changed by either lane, additively only (a new function, column, operation, reason code or
     seed row, never a changed one). They are MDM, INV, PUR, BIL, PAY (outside the card provider), FIN, DOC, AUD and
     RPT, `src/platform`, the kernel, the seed, the contract, CLAUDE.md and the shared docs.
   - A lane that needs to change the other lane's module, or an existing shape in a shared one, stops that piece and
     asks the parent session. It never makes that change on its own.
2. **Merges into main go one at a time, through the merge slot.**
   - Take the slot with the parent session's lock (`merge-slot.sh acquire <lane>`; the brief names its path).
   - Holding it:
     1. Rebase the lane branch on the latest main.
     2. Renumber the lane's migrations above main's highest if the other lane merged first.
     3. Rebuild the contract (`pnpm contract:generate`) and bump its version on top of whatever main publishes, with
        its changelog entry above main's.
     4. Push, and wait for both CI runs (push and pull_request) on the head to go green.
     5. Merge, and wait for main's push run.
     6. Release the slot.
   - Edits to the seed, CLAUDE.md and shared docs land the same way: only through the slot.
3. **Ids never collide, because each lane draws from its own block.**

   | Lane | Assumptions | ADRs | Backlog | Threat model abuse cases |
   | --- | --- | --- | --- | --- |
   | A | A-274 to A-299 | ADR-0077 to ADR-0084 | BL-077 to BL-089 | 35 to 39 |
   | B | A-300 to A-329 | ADR-0085 to ADR-0092 | BL-090 to BL-099 | 40 to 44 |

   A lane that runs out of its block asks the parent session for more. Migration numbers are renumbered at the
   rebase (rule 2); contract versions are bumped at the rebase.
4. **Docker is shared.** A local run that starts the compose stack (`pnpm run setup`, `pnpm dev`, `pnpm test:e2e`,
   `pnpm test:smoke`) binds fixed host ports, so it runs under the compose lock (`flock` on the file the brief
   names). Testcontainers runs need no lock.
5. **Usage.** If the usage limit stops either lane, the parent session resumes one lane at a time until that lane
   merges, rather than leave both stopped halfway.

## If a session cannot finish

Stop at the nearest green commit, push, write the report with a clearly marked "continued" section, and open the next session with the same opener, changing only the report it reads and adding "continued" after the identifier (`B05 continued`). Never split in the middle of a module.

## Keeping this file true

- A session that changes the plan (a split, a moved item, an owner decision on a proposed assignment) updates ADR-0026 or adds an ADR, then updates this file in the same pull request.
- A new document that a later session must read is added to that session's opener.
- The ids, slugs and branches here are the ones used in every report and every branch name. Do not rename one without renaming all three.
