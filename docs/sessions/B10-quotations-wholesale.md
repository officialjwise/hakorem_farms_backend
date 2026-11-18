# B10: quotations (lane B), split before credit control

Date: 2026-11-18 · Branch `b10-quotations-wholesale`, from `main` (`39c6198`), rebased on `main` at `5815c06` (lane A's B09b continued 1c, #107) · Status: **gate as split passed; the phase split at its sub-domain boundary (A-311).**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

| ID | What | Who confirms |
| --- | --- | --- |
| A-309 | **Quotes as built:** (a) Sales holds every QUO read and write, the Owner and the Manager too and alone `quo.quote_margin.approve`; (b) a storefront request belongs to the head office, linked by phone; (c) cost is the average of the product's live cost pools at the branch, margin over cost signed to two places (`marginPercent` widened from `Percent`), floor compared exactly, **an unknown cost needs the approval**; (d) tax only on product lines, the delivery fee untaxed in the estimate; (e) a token ledger in place of one hash (ADR-0087); (f) issuing reserves every product line in the base unit and refuses stock that is not there (`STOCK_SHORT`); (g) after an approval the message goes by SMS; (h) the staff acceptance's note is required by the rule, optional in the schema; (i) expiry every fifteen minutes. | Owner, Accountant |
| A-310 | **Conversion:** a `PLACED` order on channel `QUOTE`, lines priced `QUOTE` at the quoted price with no variance; an accepted quote's hold lasts until conversion; the hold passes to the order and its confirmation counts it; the invoice comes at fulfilment (B11), proved here through the proforma; delivery refused until B11. | Owner |
| A-311 | **The split:** QUO, CR-041 and the owner's B10 items 1, 3 and 4 and the quote half of 5 built; credit control, ageing, dunning, standing orders, holds, the over-limit order, the rest of item 5 with the second Owner or Manager, A-300 (i), UAT scenario 2, the pipeline, `listMyQuotes` and the quote's PDF move to **B10 continued**. | Owner |
| A-312 | **The frontend's request numbers, by its `main` at `81525f1`:** CR-045 a quote line's unit, CR-046 the over-limit order, CR-047 the quote link, CR-048 who quotes, holds, releases and approves, CR-049 the request form's quantity and unit; CR-050 lane A's till drop witness. The parent session's interim numbering was withdrawn. | Owner, frontend |

**No ADR conflict.** ADR-0087 is new (proposed): a quote link opens only its live version; every send gets its own token stored as a hash; a closed link answers its state only. ADR-0017 (maker and checker), ADR-0019 (quote reservations) and ADR-0074 (link tokens) are followed, not changed.

**For the parent session (owner's returns note):** returns today refund through a credit note on the original billing document's lines, priced and taxed by that document's terms (`Billing.creditPreviewIn`, `planCreditIn`), so **at the price paid, not the current list: no defect found.** The pro-rata crate-per-egg refund with ADR-0075's running-total rounding is not built anywhere yet; it is written into B11's opener with the owner's tests.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B10, lane B (`b10-quotations-wholesale`, from `main`).
2. **Scope:** QUO (FR-QUO-001 to FR-QUO-012), CR-041, the owner's items 1 (a quote line's unit), 3 (the quote link) and 4 (the form's quantity and unit) and the quote roles of item 5; split early, as the parent session advised, before credit control.
3. **Gate (as split):** quote revisions are versioned and an issued version never changes; below the margin floor a different person approves; the link opens only the live version and accepts once; an accepted quote converts to exactly one order that keeps every link, through to its proforma.

## Contract changes

**2.11.0, minor, additive** (on top of lane A's 2.10.0); `scripts/contract/versioning.ts` against `main`: ok. Redocly clean. `contract:generate --check` up to date (474 operations from code, 172 planned).
- **Into code:** the nineteen QUO operations (`getQuotePipeline` and `listMyQuotes` stay planned). `submitQuoteRequest` is public: its planned `customerSession` and optional CSRF header are gone.
- **New:** `getCustomerPriceList`, `listPriceListAssignments` (CR-041) with `PriceListAssignmentList`, `PriceListHolder`, `PriceListHolderPage`; `PriceListEntry.baseUom`.
- **Planned QUO shapes extended:** `PublicQuoteRequest`, `RfqCreate` and `Rfq` take `quantity` and `uom`; `QuoteLineInput.uom`; `QuoteLine.baseQuantity`; `QuoteVersion.createdBy`, `createdAt`, `version`, `acceptanceLinkToken`; `QuoteAcceptanceRecord.note` (optional, required by the rule). **`QuoteVersion.marginPercent` is a signed decimal string**, no longer a `Percent` (a margin over cost may be negative or above 100). `viewQuoteByLink` gains 422.
- **New error codes:** `QUOTE_INVALID`, `RFQ_INVALID`, `QUOTE_LINK_CLOSED`, `QUOTE_AUTHOR_CANNOT_APPROVE` (422); `QUOTE_ALREADY_DECIDED`, `QUOTE_ALREADY_CONVERTED` (409).
- **Seeded role matrix:** the QUO permissions.

## Built

| Item | What |
| --- | --- |
| Schema | Migrations 0252 (document types `RFQ`, `QUOTE`), 0253 (`quo`: `rfq`, `quote`, `quote_version`, `quote_line`, `quote_acceptance`, `quote_link_token`, with the freeze, the margin approval, the acceptance once, the conversion once and the numbers held by the database), 0254 (permissions and the `QUOTE_BELOW_MARGIN` policy), 0255 (grants). |
| Domain | `quo/domain/quote.ts`: the line anchor, the cost, the margin over cost and its exact floor, a version's figures (tax-exclusive and tax-inclusive), the two status machines, the link's states, the oldest-first reservation plan. |
| `Rfqs` | `submitQuoteRequest` (rate limited by address and by phone, five an hour, failing closed; the unit checked through `MasterDataRefs.toBaseIn`), `createRfq`, `listRfqs`, `getRfq`, `updateRfq`. |
| `Quotes` | create, read, list, versions, revise, edit a draft, issue (priced and judged again; 202 below the floor; reservations; supersede; one `quo.QuoteIssued`; the token once), record an acceptance, decline, withdraw, convert; the public view, accept and decline by link; the approval handler; `QuoteExpiry` (`quote-expiry`, every fifteen minutes). |
| ORD | `Orders.createFromQuoteIn`, `locksFor`, `holdLineIn`; `confirmOrder` counts what the order already holds. |
| INV, MDM | `Reservations.activeOfHolderIn`, `StockQueries.costPoolsIn`; `MasterDataRefs.weightBandsIn`, `PartiesAdmin` exported; CR-041's two reads and `baseUom`. |
| Seed | `farm-quo.ts`: Madina Market Traders' WhatsApp request for ten crates and its draft quote at 6,000 a crate, by the seeded salesperson; nothing reserved, every seeded figure unchanged. |
| Docs | ADR-0087 and its index line, ADR-0026 Amendments (the split, the returns note to B11), A-309 to A-312, the changelog, `API.md` (QUO and the codes), `data-model/quo.md`, the QUO and ORD cards, the openers (B10 marked, B10 continued inserted, B11 reads its report and carries the returns rule). |

## The gate, proved by running it

**`test/integration/quo/quotes.integration.spec.ts` (21 tests):**
- **Versions (FR-QUO-006):** 4 goats at 70,000 (cost 60,000 a head straight from `inv.cost_pool`: 240,000 for 4) is 280,000 at 16.67 percent; issued, revised to 66,000 (264,000, exactly 10.00 percent, issued without approval), issued: version 1 `SUPERSEDED` and still 280,000 in SQL, version 2 current, both listed with their author, time and totals. By direct SQL an issued version's figures, its lines, its status and a line's removal are each refused (HK004); editing it over the API is 422.
- **Margin floor (FR-QUO-005):** 263,996 over 240,000 (9.998 percent, shown 10.00) answers 202 `QUOTE_BELOW_MARGIN`, nothing held; Sales approving is 403, the author who asked is `MAKER_CANNOT_CHECK`, an author whom someone else asked for is `QUOTE_AUTHOR_CANNOT_APPROVE`; the Owner approves and the version is issued with the asker as issuer and the Owner as approver; asking again answers a fresh link and the outbox still holds one `quo.QuoteIssued`. By direct SQL, issuing below the floor without an approval, or with its author as approver, is 23514.
- **CR-045 as the owner worded it:** 3 crates at 6,000 (18,000) and 7 single eggs at 220 (1,540), each priced by its own unit's entry; the unit costs equal the hand calculation from the SQL sum of the eggs' pools (half-up once, a crate is 30 eggs); 97 eggs held for exactly the validity; `KG` is `NO_CONVERSION`, a fraction of a thousandth 400.
- **CR-047:** only the SHA-256 of each token is stored, its expiry the validity; the token is in no outbox payload, stored answer or audit row. The live token reads the version (no cost); a replaced version's token is 422 `REPLACED` and accepts nothing; a one-character change, a random `quo_` token, the quote's id, its number and a version's id are 404 to read and to accept. Accepted once: 200, then 409; the link then answers `ACCEPTED`; a second acceptance by SQL is 23505. A decline by link answers `DECLINED`, twice is 409, the hold released. Past the validity the link is `EXPIRED`, accepting and recording are refused, and the expiry job expires the quote and gives back its 60 eggs.
- **Conversion (FR-QUO-011):** the accepted goats convert into four order lines of one animal each at 66,000, every one naming the one quote line, channel `QUOTE`, the quote as source, 264,000; a replay answers the same order; again is 409; one order in SQL; un-converting by SQL is HK004. The accepted eggs' hold passes to the order (97 eggs, none left on the quote), the confirmation holds 97, not 194, and the order's proforma lines join to the order lines, the quote lines and the quote in SQL. A quote not accepted is 422; an animal line without animals `ANIMALS_REQUIRED`; a staff acceptance without its note `NOTE_REQUIRED`.
- **FR-QUO-012:** a quote naming G-0142 holds it; a second quote naming it cannot be issued (`STOCK_SHORT`) until the first is withdrawn.
- **Requests (item 4):** a request for 10 crates is 202 with its number, stored with its text as given; `KG` is `UOM_NOT_SOLD`; a quantity with no product 400; the sixth request in an hour from one address, and from one phone, is 429; a WhatsApp request from Tema Cold Store's number is linked to it, another number to nobody; a quote made from it keeps it and the request lists the quote.
- **Roles:** the Cashier, the Storekeeper and the Accountant are refused every quote and request operation (403); another branch's Owner sees no Dodowa quote and is refused one by id; a customer session and no session are 401.

**`test/integration/mdm/price-list-holders.integration.spec.ts` (4 tests, CR-041):** the caterers' assignments equal `mdm.customer_price_list` in SQL, a later window shows beside the current one, the list's holders equal the SQL rows, a buyer with none answers no rows, unknowns 404, the Farm hand 403, and the base list's entries name `EGG` for a crate and a single egg and `HEAD` for a goat.

**Walks extended:** `iam/authorisation` (the B10 routes and their bodies), `iam/no-id-is-a-key` (the four public QUO routes listed with their proof), `bil/archive-link-rollback` (the four new migrations rolled back and applied).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | `ck_quote_version_margin_approved` always true | red: 1 of 21 |
| 2 | The handler's author check removed | red: 1 of 21 (the database's check refuses it too) |
| 3 | Below the floor never asks approval | red: 3 of 21 |
| 4 | A replaced link opens | red: 1 of 21 |
| 5 | A second acceptance not refused in code | red: 2 of 21 |
| 6 | The floor compared with `<=` | red: 7 of 21 |
| 7 | The confirmation ignores what the order holds | red: 1 of 21 |
| 8 | Sales without `quo.quote.issue` | red: 16 of 21 |
| 9 | The address limit removed | red: 1 of 21 |
| 10 | A crate priced by the egg's entry (unit dropped) | red: 4 of 21 |
| 11 | CR-041's read under another permission | red: 2 of 4 |

## Test first, as it honestly happened

- **Red first:** the domain's spec (27 tests) ran red (module missing) before `quote.ts` was written. The gate spec was written before the application code; its first run, once the code compiled, was 13 of 20 red, for my own defects (the outbox table's name in the test, an idempotency key longer than 64 characters on the link writes, a session idling out after the clock moved an hour, a system job run outside a request context), each fixed before the next run.
- **Not red first:** CR-041's spec was written after its code (4 of 4 green on the first run); mutation 11 proves it bites. The author-as-checker test was added after the handler; mutation 2 proves it bites.
- **Nothing was re-run to turn red into green; no assertion was weakened and nothing was skipped.**

## Security review (hakorem-security-review)

- **Boundary:** TB1 (the storefront, no session) and TB2 (back office), and the database.
- SC-01: strict zod everywhere; a quantity only with its unit; `consentToContact` must be true. SC-02: every staff handler authorises first, deny by default (the version's quote is looked up only after the permission is held), then at the quote's branch; the identifier walk covers every new route. SC-03/04: parameterised SQL only. SC-05: integer pesewas as bigint, extended once half-up; the floor compared on integers. SC-06: every write keeps its idempotency key; the link writes scope theirs to the token's hash, never the token. SC-17: margin approval by neither author nor asker, in the handler and the database. ADR-0074: 256-bit tokens, hash only, none in an answer a replay reads, an event, an audit row or a log. Rate limits: five an hour per address and per phone, keyed by HMAC, failing closed.
- **Abuse:** a quote below cost to a favoured buyer needs a second person (abuse case 14's quote half; its credit half is B10 continued). No new exception-report source this phase.

## Deferred (to B10 continued unless named)

Credit control and the over-limit order, ageing and the statements' ageing summary with A-300 (i), dunning, standing orders, the overdue hold, A-212 (d), the hold, override and limit roles with the second Owner or Manager in the seed, UAT scenario 2, `getQuotePipeline`, `listMyQuotes`, the quote's rendered and archived document (FR-QUO-007; `documentId` and `documentUrl` are null). The link message itself is B11's (NTF). The returns rule is B11's.

## Contract requests

The frontend's `main` was read at `37e5c98`, `b537827` and last at **`81525f1`** (PR #28, F10i), by which these are answered:
- **CR-041** (who holds a buyer's price list, an entry's base unit): implemented as asked.
- **CR-045** (a quote line names its unit): implemented. Two differences from the request, kept and stated: a line with no `uom` is in the product's **base unit**, as `OrderLineInput` and every other line input read (the request says the sale unit; for eggs that would silently make "10.000" ten crates); a unit the product is not sold by is 422 `QUOTE_INVALID` `NO_CONVERSION` (the request suggests `REFERENCE_NOT_FOUND`, which names a missing record, not a unit with no conversion). Both are for the owner to confirm or change in B10 continued.
- **CR-046** (a credit order past the limit or the terms): **not built here; B10 continued** (credit control moved there by the split, A-311). Its shapes (`getOrderCreditCheck`, `requestCreditOverride`, the three refusals, `CreditOverride`'s new fields) are in that phase's opener by reference.
- **CR-047** (the quote link): points 1 and 3 implemented (the token's description; a closed link answers 422 `QUOTE_LINK_CLOSED` with `EXPIRED` or `REPLACED`, an unknown one 404, ADR-0087). One difference: a version may have **several live tokens** (one per issue answer and per send, ADR-0074 forbids keeping one in clear to send again), not one. **Point 2 (`PublicQuote.acceptedName`, `decidedAt`, `supersededAt`) is not built:** a replaced link answers no quote, so `supersededAt` has nothing to ride on; `acceptedName` and `decidedAt` go to B10 continued.
- **CR-048** (who quotes, holds, releases and approves): the QUO half implemented (Owner, Manager and Sales hold the quote and request permissions; the margin approval is Owner or Manager only), **with `quo.rfq.create` also held by Sales**, since FR-QUO-002 makes Sales the actor of `createRfq` (the request's table leaves it out). The WHL half, the release and limit-change approvals and the seeded second Owner or Manager are B10 continued's.
- **CR-049** (the request form's quantity and unit): implemented, on `PublicQuoteRequest`, `RfqCreate` and `Rfq`.
- **CR-050** (the till's drop witness, raised as CR-045): lane A's till phase; not built here.
- **CR-039:** B11. **Everything else:** answered in earlier phases or lane A's.

## Tests (this machine, 2026-11-18)

| Layer | Result |
| --- | --- |
| Unit and integration, merged (`pnpm test:coverage`), on the rebased code | **3,464 passed**, 285 files, none skipped. Statements 94.14 percent, branches 84.32 (the gate is 80), functions 97.79, lines 96.94; every 100 percent gate held. QUO's domain: 96.82 statements, 95.91 branches, 100 functions and lines. |
| Contract (`pnpm test:contract`) | **127**: the first full run was red on 3 files, each a list this phase had to extend (the operation count, the request schemas walk, a test borrowing `QUOTE_BELOW_MARGIN`), fixed; the four files rerun green (17 tests), with the new `test/contract/b10/quotes.contract.spec.ts`. |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no warning), `contract:generate`, versioning against `main` | Clean. |
| End to end, setup, the image, the scans, the last migration rolled back and applied | Run in CI; 0252 to 0255's down steps are also walked over the seeded farm by `bil/archive-link-rollback`. |

The first full merged run was red on 6 tests in 4 files, each fixed before the commit: `quo.quote_line` held DELETE, which a DOCUMENT table may not (draft lines are now set aside, never deleted; a test proves DELETE is refused); two IAM approval suites borrowed `QUOTE_BELOW_MARGIN` as an unused kind (now `DATA_DELETION`); the seed's unit count.

## Gate

**Passed, as split:** an issued quote version never changes, by the API or by SQL, and a change is a new version listed with its author, time and totals; a version below the margin floor is issued only once someone who neither drafted it nor asked approves it, held by the database; a line in a crate or a single egg is priced by its own unit and held in eggs; the quote link opens only its live version, accepts once and opens nothing by a replaced, expired or guessed token or the quote's id; an accepted quote converts to exactly one order whose lines name their quote lines, and the order's proforma joins back to the quote. **The planned gate's credit limit half is B10 continued's.**

## Notes for the frontend track

- **2.11.0:** the quote screens can use the QUO operations; `marginPercent` is signed and may exceed 100; show `QUOTE_LINK_CLOSED`'s `details[0].code` (`EXPIRED`, `REPLACED`, `WITHDRAWN`) in words; `acceptanceLinkToken` is answered only by the issue call (`/shop/quotes/{token}`).
- **Units:** send `uom` on a quote line and on the request form (a crate or `EGG`); the answer's `baseQuantity` is what is held.
- **CR-041:** `getCustomerPriceList` and `listPriceListAssignments`; `PriceListEntry.baseUom` names the unit of `minQtyBase`.

## CI

- **The code head** (pull request below): every run on it is named in the session's closing message to the parent session, with its event and conclusion; the pull request merges only when every run on its head is green.
- **This report's own commit:** a report cannot name the runs of the commit that adds it, so they are named in the session's closing message.

## Next session

B10 continued, copied from `docs/prompts/session-openers.md` (inserted by this phase's split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md, and "Two lanes" below.
List docs/sessions/ and read only the most recent report (docs/sessions/B10-quotations-wholesale.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
On the frontend's main at 81525f1 (A-312): CR-046 (an order past the limit or the terms), CR-047's remaining point 2
(PublicQuote.acceptedName and decidedAt), CR-048 (the role matrix and seed for quotes and wholesale, a second person on
a release and a limit change) and CR-045's unit left out meaning the sale unit (B10 answered: the base unit) are this
phase's to implement or decline; check the numbers again on main, the owner's rule.
For this phase, read the WHL requirement block of docs/SRS.md and FR-QUO-007 and FR-QUO-013 of the QUO block (nothing
else from the SRS), docs/data-model/whl.md and quo.md, the WHL and QUO cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL
section 5.12, ADR-0017, ADR-0085, ADR-0087, the abuse case 14 in docs/security/THREAT_MODEL.md, and A-300 and A-309 to
A-312 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B10 continued only, on branch b10c-credit-control from main, building on QUO as B10 merged it (do not
rewrite it): business accounts with credit limit, terms, the assigned price list and account manager, and exposure
(SRS SA-21: outstanding invoiced balance plus confirmed uninvoiced orders); WHL's implementation of ORD's
OrderConfirmationPolicy port; the credit override with a different approver (CREDIT_OVERRIDE, abuse case 14); ageing
by 30, 60 and 90 days computed from invoice due dates and allocations, as at a date; FR-WHL-009's ageing summary added
to customer statements additively, and decide A-300 (i), money held on deposit for the customer (2200), the most
conservative way, recorded and flagged for the owner; dunning levels and notices (sendStatement and the sends stay
B11's); standing orders and their runs; the automatic hold past the overdue threshold. The owner, 2026-11-16 (A-212 (d)):
a bounced cheque (a reversal with CHEQUE_DISHONOURED) counts against the customer's credit standing.
The over-limit order (CR-046, the owner's words for B10): an order over the customer's credit limit or
past their terms does not go through. An approval request in place of a plain refusal is kept, but the response carries
the amount over the limit and the reason (over limit, past terms, or both), the order stays blocked until approved, the
override needs a written reason, and the approver is never the person who asked (mutation-checked). Exact pesewas at
the limit, one pesewa over, and past terms by one day; exposure and ageing asserted against SQL sums straight from the
owning tables, never from the function under test.
Roles (the owner's item 5, the rest of it, and CR-048): the Accountant may put an account on hold;
releasing a hold, approving a credit override and changing a credit limit are Owner or Manager only, never by the person
who asked; a wrong-role refusal test and a maker-is-checker refusal test for each of the three, mutation-checked and held
by the database the way the supplier invoice approval of CR-043 is. The seed has a second Owner or Manager at the branch,
so a hold's release and a credit-limit change always have someone other than the requester to approve them: test that
with the seeded people (invented names only, hakorem-seed). IAM is lane A's: additive role-matrix and seed grant rows
only, with the parent session's leave.
QUO's remainder (FR-QUO-007, FR-QUO-013): the quote rendered and archived as a document when a version is issued
(DOC's template, `documentId` and `PublicQuote.documentUrl`), getQuotePipeline (win rate by salesperson and product
line, reconciling to listQuotes) and listMyQuotes (a customer's own quotes only).
Run scenario 2 of docs/UAT.md as a dry run and record every difference, including the two rules that scenario flags for
the owner (credit check and delivery fee on a partial dispatch), decided conservatively and put to the owner.
Stop at the gate and write docs/sessions/B10c-credit-control.md.
```
