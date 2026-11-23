# B10 continued 5: the quote's document, the pipeline, subject to stock and UAT scenario 2 (lane B)

Date: 2026-11-23 · Branch `b10c5-quote-document-pipeline`, from `main` at `f6aadd0` (#120, lane A's B09b continued 3c) · Status: **gate passed locally; CI below.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

| ID | What | Who confirms |
| --- | --- | --- |
| A-328 | **Subject to stock (the owner's item 3; A-309 (f) amended, dated):** `issueQuoteVersion` no longer refuses stock not on hand; each product line holds its base quantity or what is on hand, whichever is less, never more (ADR-0019's cap unchanged); a named animal not free holds nothing; what was there and what was held are recorded once per line (`quo.quote_line_stock`); a balance below zero is nothing on hand (ADR-0081). Subject to stock is derived (available below the line's base quantity). **Staff see `availableQuantity` and `heldQuantity`; the buyer sees only the flags, never the farm's stock level.** An unnamed animal is still chosen at conversion and held by nobody. | Owner |
| A-329 | **The pipeline:** Accra dates both included over the quote's creation (the instants `listQuotes` filters by); quotes ever issued only (open, accepted, declined, expired, converted); **a withdrawn quote is left out**, neither won nor lost; accepted counts converted; win rate `0.00` with nothing closed; values are the gross of the accepted version, else the last issued; permission `quo.report.read` to Sales, the Manager and the Owner. | Owner, Accountant |
| A-330 | **The quote's document:** each issued version is archived once as revision N (its version number) of the quote's document, from a new `QUOTE` A4 template; `documentUrl` is signed for the link's holder (logged under the Storefront) or the signed-in customer (logged under them), null until rendered and scanned clean. | Owner |
| A-331 | **UAT scenario 2's two owner rules, decided conservatively:** (a) the credit check counts the whole unpaid order whatever deposit is to come (as built, A-313 (a)); (b) a delivery fee is charged once, on the first dispatch (for B11). | Owner |

**No ADR conflict.** ADR-0019 was read first: holding only what is on hand is exactly its reservation rule (a reservation never above on hand), so subject to stock adds a record and removes a refusal; it changes no reservation rule. ADR-0074 and ADR-0087 hold: no token is in any render data, render job or outbox message (tested); `documentUrl` reaches only a caller who already holds the link's token or is the signed-in customer. ADR-0061: the render is requested in the issuing transaction and archived after commit. ADR-0067: no new `now()` in business SQL; the dates come from the application clock. A-323 and A-324 are kept: approval never makes a link.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B10 continued 5, lane B (`b10c5-quote-document-pipeline`, from `main`).
2. **Scope:** FR-QUO-007's document and `documentUrl`, FR-QUO-013's `getQuotePipeline`, the owner's item 3 (subject to stock, after ADR-0019), UAT scenario 2's dry run.
3. **Gate:** an issued quote version is rendered and archived once and `PublicQuote.documentUrl` opens it; the pipeline reconciles to listQuotes; a quote for stock not on hand is issued subject to stock with exact quantities and reserves only what is on hand; UAT scenario 2's dry run is recorded with every difference; every write refuses the wrong role.

## Contract changes

**2.23.0, minor, LOUD on one behaviour** (on top of lane A's 2.22.0; Redocly clean, no warnings; `contract:generate`: 505 operations from code, 148 planned, 653 in all).
- **LOUD on 2.12.0:** `issueQuoteVersion` issues a quote for stock not on hand `subjectToStock` where it answered 422 `QUOTE_INVALID` `STOCK_SHORT`; `STOCK_SHORT` remains only for a balance changed under a concurrent issue.
- **Into code:** `getQuotePipeline` (`GET /quotes/pipeline`) with its planned `QuotePipeline` and `PipelineRow`, described in full; a new 400 detail `PERIOD_ENDS_BEFORE_IT_STARTS`.
- **Response fields (additive, always sent):** `QuoteVersion.subjectToStock`; `QuoteLine.availableQuantity`, `heldQuantity`, `subjectToStock`; `PublicQuote.subjectToStock`; `PublicQuoteLine.subjectToStock`. **Now filled:** `QuoteVersion.documentId`, `PublicQuote.documentUrl`.
- Every QUO example carries the new fields. No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| Schema | 0288 (QUO): `quo.quote_line_stock` LEDGER (once per line, held never above what was there, `quo.quote_line_stock_check` HK004: its own version's product line, before issue, held never above the line). 0289 and 0290 (IAM, additive lookup and grant rows): `quo.report.read` to Sales, the Manager, the Owner. 0291 (DOC, additive lookup rows): the `QUOTE` A4 template, version 1, with SAMPLE data. Each has a tested rollback (the archive-link rollback walk). |
| QUO domain | `planHold` (replaces `planReservation`: pieces, what was there, held and short; below zero is nothing), `pipeline.ts` (`pipelineFigures`, `pipelinePeriod`, `offsetPage`). |
| QUO application | `reserveLinesIn` holds what is on hand and records it; the views' new fields; `renderDataIn` and the render request in `issueIn` (revision = version number); the `quo.quote-archive-link` consumer of `doc.DocumentArchived`; `documentUrlIn` on the public view and `listMyQuotes`; `Quotes.pipeline`. |
| QUO infrastructure and interface | `PgQuoteStore` (`insertLineStock`, `lineStockOf`, `setArchivedDocument`, `versionByNo`, `pipelineCells`); `getQuotePipeline` declared before `quotes/:id`; `QuotePipelineQuery`; the operation's fragment. |
| DOC and platform (additive) | `RenderRequest.revision` and `RenderRequested.revision` (optional; absent is 1), `Documents.signedUrlIn`; `FileStore.signedLink(..., onBehalfOf?)` for a public caller authorised by the module. |
| Docs | A-328 to A-331, A-309's dated amendment; the 2.23.0 entry; `data-model/quo.md`; the QUO card; `API.md`; the openers (B10 continued 5 marked built, B11 given A-331 (b) and the rest of scenario 2's dry run). |

## The gate, proved by running it

**`test/integration/quo/quote-document-pipeline.integration.spec.ts` (6 tests):**
- **The pipeline (FR-QUO-013's acceptance):** Kojo Antwi's 4 accepted, 3 declined, 3 expired (by the `quote-expiry` job) and 2 open quotes answer `issued 12, accepted 4, declined 3, expired 3, converted 0, winRatePercent "40.00"` with `issuedValuePesewas` and `wonValuePesewas` equal to the sums of each quote's gross read back by `getQuote`; Esi Appiah's open quote and her converted one answer `2, 1, 1, "100.00"`, her draft, the seed's draft and her withdrawn quote left out. **Reconciliation:** for the same instants, `listQuotes` by status gives ISSUED + ACCEPTED + DECLINED + EXPIRED + CONVERTED = the pipeline's `issued` (14), accepted = ACCEPTED + CONVERTED, declined, expired and converted each equal; DRAFT 2 and CANCELLED 1 are in the list and not the pipeline. By product line: goats 5 issued, 4 won, `100.00`; eggs 9, `14.29`. `/quotes/pipeline` answers 200 (never read as a quote's id); paged by a cursor another caller cannot use (400); an empty period `[]`; `to` before `from` 400 `PERIOD_ENDS_BEFORE_IT_STARTS`.
- **Roles and branches:** the Cashier, the Storekeeper and the Accountant 403; another branch's Owner 200 with no row; a customer session and none 401.
- **Subject to stock, exact quantities against INV's reservations:** fully on hand, one crate holds `30.000`, not subject; partly, 1,000 crates (`30000.000` eggs) hold exactly what was left (`availableQuantity` = `heldQuantity` = the eggs' promisable stock less those 30, equal to `sum(inv.stock_reservation.qty)`), subject; not on hand, two crates hold `0.000`, subject, issued 200; a named goat already held by a quote: the second quote issued subject, `0.000`, the first keeps it; an unnamed goat line holds `0.000`, not subject. The buyer sees `subjectToStock` on the quote and the line and never the stock figure. A replayed issue records the line once.
- **The database:** held above what was there 23514; held above the line, a line of another version and a version already issued HK004; a second row for a line 23505; update 42501 to `hk_app`, update and delete HK001 beneath.
- **The document:** version 1, issued, replayed and given a further link, is archived exactly once (revision 1, `QUOTE`, its number, its PDF `QUO-....pdf` in the private archive) and its `documentId` names it; version 2 is revision 2 with its own `documentId`, version 1 keeping its; the render data are the version's formatted figures with "subject to stock" per line; setting a version's document a second time HK004.
- **`documentUrl`:** a signed URL through the link and in `listMyQuotes`, each logged in `platform.file_access_log` under the Storefront principal and the customer; another customer's list holds none of it; a guessed token and the quote's id 404; no token in any render data, render job or outbox message; null before the render and **null while the archived PDF has not passed the scan**, signed once it has.

**`test/integration/quo/quotes.integration.spec.ts`:** the named-animal test now expects the second quote issued subject to stock holding nothing (LOUD), the first keeping G-0142; the public line's keys include `subjectToStock`.

**Unit:** `quote.spec.ts` (`planHold`: fully, partly, not on hand, below zero) and `pipeline.spec.ts` (40.00 from 4, 3 and 3 with a converted quote counted as accepted; half-up 66.67, 12.50, 16.67, 100.00; 0.00 with nothing closed; the period; the pages).

**Contract:** `test/contract/b10c5/quote-document-pipeline.contract.spec.ts` (a version issued subject to stock, its public quote with `documentUrl`, the pipeline and its 400, against 2.23.0). **Walks extended:** the authorisation walk (`getQuotePipeline` with its query), the identifier walk (it takes none), the rollback walk (0288 to 0291), the operation counts.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | What was on hand shown as all of the line | red: 3 |
| M2 | Subject to stock never flagged | red: 3 |
| M3 | A balance below zero counted as stock (`planHold`) | red: 1 (unit) |
| M4 | Every version archived as revision 1 | red: 2 |
| M5 | The render never requested | red: 2 |
| M6 | The archive link consumer not registered | red: 2 |
| M7 | A converted quote not counted as accepted | red: 1 |
| M8 | A withdrawn quote counted in the pipeline | red: 1 |
| M9 | The pipeline not filtered by branch | red: 1 |
| M10 | The pipeline authorised nowhere | red: 1 |
| M11 | The period's last day left out (`pipelinePeriod`) | red: 1 (unit) |
| M12 | `documentUrl` signed before the scan has passed the PDF (DOC's `signedUrlIn`) | red: 1 |

Not mutation-checked: `getQuotePipeline` needing only `quo.quote.read` (no seeded role holds one without the other, as in B10 continued 4's mutation 9), and the route declared after `quotes/:id` (the spec's 200 on `/quotes/pipeline` would turn 400; not run).

## Test first, as it honestly happened

- **Domain first, red first:** the `planHold` tests were written and run red (4 failing) before `planHold` existed; the pipeline tests likewise (3 failing) before `pipelineFigures`.
- **The integration spec was written after the application code**, against the gate's list, then run: red on four counts, each mine: the archive link left `documentId` null (the version's `touch_version` trigger needs the version bumped: a real bug, fixed in the store); the list's DRAFT count (the seed's draft quote, which I had not counted); a second row for an issued line refused HK004 before 23505 (the test now proves each refusal on its own row); and the render data's subject-to-stock flag (every egg was held by then, so the version is rightly printed subject to stock). The mutation table above is the proof that each test can fail.
- **Nothing was re-run to turn red into green; no assertion was weakened and nothing was skipped.**

## Security review (hakorem-security-review's checklist, item by item)

- **Boundary:** TB1 (the public link and `listMyQuotes` now carry a signed URL), TB2 (the pipeline), the database.
- **Authorisation:** `getQuotePipeline` authorises in the handler first, deny by default, over the caller's whole branches only; wrong roles refused and mutation-checked; on the authorisation walk. `documentUrl` is made only inside a view the caller already reached by the link's token or their own session.
- **Downloads:** the URL is signed and expiring, logged with its purpose (`quo.quote.document`) and principal, and only for a PDF the scan has passed (mutation-checked). The token never enters render data, a job or the outbox.
- **Data:** `quo.quote_line_stock` is DC-22 (`quo.quote*`), CONFIDENTIAL; the buyer never sees a stock level (A-328 (c)). **Money:** the pipeline sums whole integer pesewas; the win rate is half-up once on integers.
- **New abuse path:** none beyond those listed: a forwarded link already opened the quote; the signed URL lapses with the platform's lifetime. Not applicable: payments, webhooks, uploads, exports.

## UAT scenario 2, dry run: differences

Walked step by step against the system as built and its tests (`quotes`, `quote-links`, `quote-document-pipeline`, `credit-control`, `ageing-dunning` and the order specs), not keyed in end to end: section 3's facts (twenty goats of band GOAT-M at a list of 850.00, Emmanuel Tetteh C-00241) are not the seeded farm's, and steps 2.12 to 2.16 need B11's pick, dispatch and delivery.

- **2.1, 2.4 to 2.7, 2.10, 2.21 (to the order and its proforma):** as the scenario expects: the request linked to its customer; the link opens version 1 with its terms and expiry (and now its PDF); an issued version refuses a change (HK004 beneath, `INVALID_STATE_TRANSITION` above); version 2 supersedes it and the old link answers `QUOTE_LINK_CLOSED` `REPLACED`; accepted once (a second accept 409); the override list names who approved.
- **2.2, tax on the delivery fee:** the quote's estimate leaves the delivery fee untaxed (A-309 (d)): tax GHS 0.00 and gross GHS 19,060.00 where the scenario expects GHS 12.00 and GHS 19,072.00. The invoice at dispatch (B11) taxes it.
- **2.2 and 2.5, the margin's basis:** built as margin over cost (A-309 (c)): (19,060.00 - 13,200.00) / 13,200.00 = **44.39 percent**, version 2 **44.44 percent**; the scenario's 30.75 and 30.77 are margin over the selling price. Both clear the 10 percent floor here. **Put to the owner** (question 3).
- **2.3 and 2.6, reserved goats:** the scenario expects 20, then 18, goats reserved; as built (A-309 (f)) goats the line does not name are chosen at conversion and held by nobody, so nothing is reserved and the line shows `heldQuantity` 0.000. The SMS to Emmanuel is queued (`quo.QuoteIssued`) and sent by B11's NTF.
- **2.8, conversion:** a live-animal line converts only with its animals named (`ANIMALS_REQUIRED`), so Kojo picks the eighteen tags at conversion; the scenario does not say so.
- **2.9, the credit check:** refused with `CREDIT_LIMIT_EXCEEDED` on the whole GHS 17,172.00 and an override asked for; Kojo cannot approve his own (`MAKER_CANNOT_CHECK`). **The owner's first rule** (the whole unpaid order counts, whatever deposit is to come) is the rule as built, A-331 (a).
- **2.11:** the bank transfer is a payment held on the order (`DEPOSIT_HELD`, account 2200).
- **2.12 to 2.16:** B11 (pick with weights, dispatch with the invoice on the ten goats, the deposit allocated, proof of delivery). **The owner's second rule** (the delivery fee once, on the first dispatch) is A-331 (b), written into B11's opener.
- **2.17 to 2.19, ageing:** the buckets are as the scenario expects (due on day 30 is Current; a day past due is 1 to 30), proved by `ageing-dunning`; the figure GHS 486.00 needs the invoice of 2.13.
- **2.20, the trial balance:** a converted order's lines carry the quoted price as list, floor, ceiling and agreed price with no variance (A-310 (a), approved by the owner), so the ten goats would post GHS 9,500.00 to 4000 and nothing to 4210, where the scenario expects 8,500.00 and a 1,000.00 price variance. **Put to the owner** (question 4): the script or the rule should change.

## Deferred

To **B11**: scenario 2 from step 2.12 with A-331 (b), the quote's SMS and its link. Backlog: none new.

## Questions for the owner

1. **Credit check (scenario 2, step 2.9):** the whole unpaid order counts against the limit, whatever deposit is still to come (A-331 (a)). Agreed?
2. **Delivery fee on a partial dispatch (step 2.13):** charged once, on the first dispatch (A-331 (b)). Agreed?
3. **The quote's margin (steps 2.2 and 2.5):** built over cost (44.39 percent), the floor of 10 percent compared on that; the UAT script reads margin over the selling price (30.75 percent). Which is the farm's?
4. **A quote above the list price (step 2.20):** the converted order posts the agreed price to sales with no variance (A-310 (a)); the script posts the list price and the difference to 4210. Should a quoted price above or below list post its variance to 4210?
5. **Subject to stock (A-328 (c)):** the buyer sees that a line is subject to stock, not how much the farm has. Should the buyer see the quantity available too?
6. **The pipeline (A-329 (b)):** a withdrawn quote is neither won nor lost and is left out. Agreed?

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since B10 continued 4)

- No request names the quote's document, the pipeline or subject to stock; nothing new on `main`.
- **CR-059** (the exception report), **CR-060, CR-061, CR-062** (egg reports, the VAT return, report exports and their seed): RPT and B12's; **larger, named for the parent session to schedule with B12**.
- **CR-053 to CR-057:** B11's, in its opener. **CR-050 part 1, CR-051, CR-052:** lane A's POS.
- **CR-045 to CR-049, CR-058, CR-047 point 2:** answered in B10 to B10 continued 4. Older requests are answered in their phases.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`), on `main` at `f6aadd0` (main had not moved when the merge slot was taken, so no rebase or renumbering was needed) | **3,799 passed**, 315 files, none skipped, on `70d3ef7`: the whole integration suite once, in 804 seconds. Statements 94.15 percent, branches 83.97 (the gate is 80), functions 97.85, lines 97.06; every 100 percent gate held. |
| Unit alone | 1,824 passed, 153 files |
| Contract (`pnpm test:contract`) | The first full run was red on 1 test of 133 (52 files), this phase's: the planned operation count (149, now 148 with `getQuotePipeline` in code); fixed, then that file and the new `b10c5` spec 6 of 6; CI's contract job ran all 53 files green on `70d3ef7`. |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean |
| CI on `70d3ef7` (before this report) | push 45113274394 success, pull_request 45113295297 success. Shards 4.3, 3.9 and 5.7 minutes against the 12-minute limit (NFR-016); the coverage gate 0.4. |

## Notes for the frontend track

- **2.23.0:** a quote issued for stock not on hand is no longer refused: show `subjectToStock` on the quote and each line, and on the console `availableQuantity` and `heldQuantity` (base unit). The shop's quote page shows the flags only.
- **The quote's PDF:** `currentVersion.documentId` (staff, `getArchivedDocument`) a few seconds after issue; the buyer's `documentUrl` on the link page and in the account's quotes, a signed URL that lapses (read the quote again for a fresh one), null while it renders.
- **The pipeline:** `getQuotePipeline?from=&to=&groupBy=SALESPERSON|PRODUCT_LINE`, dates both included; its rows add up to the quote list's counts for the same days.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request (#121) merges only when each is green.

## Next session

B11, copied from `docs/prompts/session-openers.md` (this phase added A-331 (b) and the rest of scenario 2's dry run to it).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B10c5-quote-document-pipeline.md).
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
- CR-056: grant B11's permissions in the seed. A Driver sees and records only their own runs and may upload
  proof-of-delivery photographs only; a Storekeeper picks and packs; a Manager plans runs and dispatches. Each grant
  gets a wrong-role refusal test and an other-driver's-run refusal test.
- CR-057: the driver hands delivery cash in at a till shift. Add the operation: the till records each collection
  handed in, against the driver's run, and the driver variance report shows anything short. It is never typed in as
  loose cash. The cash goes only onto the receiving cashier's own open shift, through PAY's TillShiftCheck (ADR-0077),
  and each collection is handed in exactly once. Test it with exact pesewas, including a short hand-in. POS is lane
  A's: the parent session gives B11 leave for this one additive POS operation and its tests, keeping lane A's till-cash
  rules unchanged.
- CR-054: a proper short-pick shape with the customer's consent, instead of a same-product substitution.
- CR-055: recording a part delivery.
- The part-crate return rule above stands.
UAT scenario 2's rule for a partial dispatch (B10 continued 5, A-331 (b), open with the owner): a delivery fee is charged
once, on the first dispatch of an order, never again on a later one; test it with exact pesewas (steps 2.12 and 2.13),
and finish scenario 2's dry run from step 2.12, recording every difference.
Stop at the gate and write docs/sessions/B11-fulfilment-delivery.md.
```
