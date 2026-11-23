# B10 continued 4: the quote link and the buyer (lane B), split before the quote's document and the pipeline

Date: 2026-11-23 · Branch `b10c4-quote-pipeline`, from `main` at `43a1174` (#118, lane A's B09b continued 3b) · Status: **gate as split passed locally; the phase split at its sub-domain boundary (A-327).**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

| ID | What | Who confirms |
| --- | --- | --- |
| A-324 | **Several live links per version:** each issue call on an issued version makes one more link and answers its token and `acceptanceLinkId` once; `QuoteVersion.links` lists them with their state, never a token. `revokeQuoteLink` (`quo.quote.issue`, at the quote's branch; another branch 403 as QUO's other routes) revokes one link once, insert-only and audited. **A revoked link opens nothing: 404**, not 422, since it was revoked because it reached the wrong person. The quote is decided once across all links (QUO, `uq_quote_acceptance_version`, new `uq_quote_link_decision_version`); every link closes on replace, accept, decline, withdraw or expiry (ADR-0087 unchanged). Approval never makes a link (A-323 kept). | Owner |
| A-325 | **The device and session behind a decision through a link (abuse case 40):** recorded once in `quo.quote_link_decision` (address, user agent, and the staff principal and session of a **live** staff access cookie, if the browser sent one); one with a staff session publishes `quo.QuoteLinkDecidedInStaffBrowser` for B12's `QUOTE_ACCEPTED_BY_STAFF` and **never blocks**. QUO reaches IAM's exported `AuthenticationService` through Nest's container (`ModuleRef`, not strict) because IAM's module does not export the provider and IAM is lane A's; **nothing in IAM's code changed**. `PublicQuote.decidedAt` is null for a decline staff recorded (BL-095). | Owner (a, b), parent session (c) |
| A-326 | **`listMyQuotes`:** customer realm only; the session's customer's quotes ever issued (ISSUED, ACCEPTED, DECLINED, EXPIRED, CONVERTED), at every branch, newest first, cursor bound to the caller; never a draft, an approved or waiting version, or a withdrawn quote; `status` in the buyer's words; `documentUrl` null until B10 continued 5. | Owner |
| A-327 | **The split** (ADR-0026 Amendments): the quote's document (FR-QUO-007), `getQuotePipeline` (FR-QUO-013), the owner's item 3 (subject to stock, after ADR-0019) and UAT scenario 2's dry run move to **B10 continued 5** (`b10c5-quote-document-pipeline`), inserted before B11. | Owner |

**No ADR conflict.** ADR-0087 (every token of a version opens it while live; a closed link answers its state) is followed and extended by the revoke (a revoked link is not a state the buyer is shown, so it is 404 like any unknown token). ADR-0074 (only the hash is kept; the token answered once) is tested. ADR-0017 (authorisation in the handler, deny by default) holds for the new write. ADR-0067: the decision and revocation are dated by the application clock; `quo.quote.updated_at`, set by the database's clock, is not shown (hence BL-095). ADR-0019 was not needed: item 3 moved with the split.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B10 continued 4, lane B (`b10c4-quote-pipeline`, from `main`).
2. **Scope:** QUO's remainder and the owner's QUO decisions of 2026-11-18; split early at the link/buyer boundary, because the document, the pipeline, subject to stock and the UAT dry run do not fit this context to their gate.
3. **Gate (as split):** several live links per version, each revoked on its own, the quote decided once across them and every link closed when its version is replaced, accepted or expires; every decision through a link records its device and staff session and one from a staff browser is flagged, never blocked; the token is shown once; listMyQuotes answers only the caller's own quotes; each mutation-checked; every write refuses the wrong role.

## Contract changes

**2.21.0, minor, LOUD on one error answer** (on top of lane A's 2.20.0; Redocly clean; `contract:generate`: 504 operations from code, 149 planned, 653 in all).
- **New:** `revokeQuoteLink` (`POST /quote-links/{id}/revoke`, `quo.quote.issue`, `ReasonRequest`, answers `QuoteVersion`).
- **Into code:** `listMyQuotes` (`GET /me/quotes`, customer realm) with its planned `PublicQuotePage`.
- **Response fields (additive, always sent):** `QuoteVersion.acceptanceLinkId`, `QuoteVersion.links` (new `QuoteLink`); `PublicQuote.acceptedName`, `PublicQuote.decidedAt` (CR-047 point 2). Planned `ExceptionKind` gains `QUOTE_ACCEPTED_BY_STAFF`.
- **LOUD (BL-093):** `approveRequest` on a `CREDIT_NOTE` the database refuses answers 422 `CREDIT_NOTE_EXCEEDS_ORIGINAL` (now listed in its `x-error-codes`) where it answered 500. The one-line list addition is in IAM's fragment `approveRequest.yaml`, contract text only; named here for the parent session.
- No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| Schema | 0282 (QUO): `quo.quote_link_revocation` LEDGER (one per link), `quo.quote_link_decision` LEDGER (one per version, `ck_quote_link_decision_staff`, `quo.quote_link_decision_check` refusing a decision through another version's link or a revoked one, HK004). Rollback tested by the archive-link walk. |
| QUO application | `Quotes.revokeLink`, `Quotes.mine` (listMyQuotes), `linkIn` (id and token), the decision record and the staff flag in `linkWrite`, `QuoteVersion.links` and `acceptanceLinkId`, `PublicQuote.acceptedName` and `decidedAt`; the `StaffSessionLookup` port. |
| QUO infrastructure and interface | `IamStaffSessions` (IAM's `AuthenticationService` through `ModuleRef`), `PgQuoteStore` additions, `staffAccessTokenOf` (the staff realm's cookie on the link's two writes), `revokeQuoteLink` route, `MyQuotesController`. Event `quo.QuoteLinkDecidedInStaffBrowser` in `events.ts`. |
| BIL (BL-093, at the parent session's request) | The credit note approval handler translates the credit cap's refusal as the direct path does. |
| Docs | A-324 to A-327; BL-093 marked done, BL-095; ADR-0026 Amendments; threat model abuse case 40; DATA_CLASSIFICATION (DC-22, DC-27, L-1); `data-model/quo.md`; the QUO card; `API.md`; `DOMAIN_MODEL.md` (the event); the changelog; the openers (B10 continued 4 marked, B10 continued 5 inserted, B11 reads its report). |

## The gate, proved by running it

**`test/integration/quo/quote-links.integration.spec.ts` (12 tests):**
- **(a) Revoke one link:** three links of one version, all OPEN, three different tokens; the first revoked by Sales with its reason: `REVOKED` with who and why, the other two OPEN; the revoked token's view, accept and decline 404 with nothing of the quote; the others open it; revoked again 422 `INVALID_STATE_TRANSITION` `REVOKED`; audited once; one revocation row.
- **Roles and identifiers:** the Cashier, Storekeeper and Accountant 403; another branch's Owner 403; an unknown id, the version's id and the quote's id 404; a customer session and no session 401; nothing changed.
- **(b) Decided once:** the other two links accepted at the same instant: one 200, one 409 `QUOTE_ALREADY_DECIDED`; a further accept or decline through either 409; one acceptance row, one decision row. **(c)** accepted, both links show `ACCEPTED` with `acceptedName` and `decidedAt` (CR-047 point 2).
- **(c) Replaced:** two links of version 1, version 2 issued: view, accept and decline through both 422 `QUOTE_LINK_CLOSED` `REPLACED`; both listed `REPLACED`. **(c) Expired:** two links of a one-day quote, three days on: both 422 `EXPIRED`, listed `EXPIRED`; the buyer's list says `EXPIRED`.
- **Abuse case 40:** an acceptance with no staff session records the address `198.51.100.23` and the user agent, no staff, no flag; one from a browser holding Sales's session records Sales and that session id and raises one `quo.QuoteLinkDecidedInStaffBrowser` naming Sales (abuse case 40, 6,000 pesewas), with no address, user agent or token in it, and the quote is ACCEPTED all the same; a decline from the Manager's browser is flagged with the Manager, and its `decidedAt` is the decision's; a cookie that is no live session is not flagged.
- **The database:** a decision through another version's link HK004, through a revoked link HK004, a second revocation 23505, a staff principal without its session 23514, a second decision for a version 23505; both tables 42501 to `hk_app` on update, HK001 beneath on update and delete.
- **Token shown once:** after five links, `getQuote`, `listQuoteVersions`, `listQuotes`, the public view and `listMyQuotes` carry none of the tokens (and `acceptanceLinkToken`, `acceptanceLinkId` null), and no outbox message or stored idempotent answer holds one.
- **listMyQuotes:** the buyer sees exactly their two issued quotes, newest first (`ISSUED`; `ACCEPTED` with their name), never their draft or another customer's quote, and no cost, margin, salesperson or id; the other buyer sees only theirs; paged by a cursor another customer cannot use (400). Another customer's quote id, version id, number or link id opens nothing on the public view (404); a customer session on a staff route 401; a staff session or none on `/me/quotes` 401.

**`test/integration/bil/settlement-write-off.integration.spec.ts`:** the credit note reaching the amount written off is now asserted 422 `CREDIT_NOTE_EXCEEDS_ORIGINAL` at its approval; **red first** (500 `INTERNAL`), then green with the fix.

**Contract:** `test/contract/b10c4/quote-links.contract.spec.ts` (issue, revoke, its refusal, the decision, the decided public quote and `listMyQuotes` against 2.21.0). **Walks extended:** the authorisation and identifier walks (`revokeQuoteLink` with its body; `listMyQuotes` as the caller's own, taking no identifier), the rollback walk (0282), the operation counts and the request schemas.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | A revoked link still opens (QUO's check removed) | red: 1 |
| 2 | QUO does not refuse a second decision through another link | red: 1 (the database's `uq_quote_acceptance_version` refuses it beneath, answered 500 where 409 is expected) |
| 3 | A replaced version's links still open (`linkState`) | red: 1 |
| 4 | An expired version's links still open (`linkState`) | red: 1 |
| 5 | The staff flag skipped | red: 2 (accept and decline) |
| 6 | The staff session never looked up | red: 2 |
| 7 | The decision not recorded | red: 4 |
| 8 | The revoke not checked at the quote's branch | red: 2 |
| 9 | The revoke needing only `quo.quote.read` | green: no seeded role holds `quo.quote.read` without `quo.quote.issue` (A-309 (a)), so the two are indistinguishable today |
| 9b | The revoke authorised nowhere | red: 2 |
| 10 | `listMyQuotes` not filtered by customer | red: 1 |
| 11 | `listMyQuotes` listing drafts and withdrawn quotes | red: 2 |
| 12 | The database letting a decision through a revoked link | red: 1 |
| 13 | `uq_quote_link_decision_version` removed | red: 1 |
| BL-093 | The fix itself absent (the code before the fix) | red: 1 (500 `INTERNAL`) |

## Test first, as it honestly happened

- **BL-093:** the assertion was changed first and run red (500 `INTERNAL` where 422 was expected), then the handler fixed.
- **The QUO work:** the code was written before its integration spec, against the opener's list of tests, and the spec was then run: 8 of 12 green on the first run; red for one wrong expectation of mine (another branch's Owner is 403 in QUO, not 404, as the existing quote tests prove), for supertest calls I built before awaiting them, and for `decidedAt` on a decline, which I first took from `quo.quote.updated_at`: that column is set by the database's clock, so the decline's time now comes from the link decision (ADR-0067; BL-095 for a decline staff record). Then one red for staff sessions that lapse when the clock moves three days on (the test signs in again). The mutation table above is the proof that each test can fail.
- **Nothing was re-run to turn red into green; no assertion was weakened and nothing was skipped.**

## Security review (hakorem-security-review's checklist, item by item)

- **Boundary:** TB1 (public storefront: the link's writes now read one more cookie), TB2 (back office: the revoke), the database.
- **Identity, sessions:** no login change. The staff cookie on a public call is only authenticated by IAM, never trusted; a malformed or dead one is no session. It is never logged or stored; only the principal and session ids are kept.
- **Authorisation:** `revokeQuoteLink` authorises in the handler first, deny by default, at the quote's branch; wrong roles refused and mutation-checked; on both walks. `listMyQuotes` finds the customer from the session, never from input; another customer's ids open nothing.
- **Input:** strict zod (`ReasonRequest`, the page query); SQL parameterised. **Money:** no arithmetic; integer pesewas in the flag.
- **Logging and data:** the address and user agent are DC-27 data in a LEDGER table (L-1 updated); the outbox flag carries neither, nor any token.
- **New abuse path:** abuse case 40 added with its control, detection and exception kind (`QUOTE_ACCEPTED_BY_STAFF`, B12). Not applicable: uploads, payments, webhooks, exports (none in this change).

## Deferred

To **B10 continued 5**: the quote's document and `documentUrl`, `getQuotePipeline`, the owner's item 3 (subject to stock), UAT scenario 2's dry run with its two owner questions. Backlog: BL-095 (a decline staff record dated). B12: the exception report reading `quo.QuoteLinkDecidedInStaffBrowser`.

## Questions for the owner

1. **A revoked link (A-324 (b)):** it answers "no such link" (404), like a guessed one, so whoever holds it learns nothing. Should it instead say the farm withdrew this link?
2. **A quote decided from a staff browser (A-325):** it is recorded and raised for review, never refused, since a salesperson may help a customer on the customer's own phone. Agreed?

## Contract requests (the frontend's `main` at `66b1be7`)

- **CR-047 point 2:** implemented: `PublicQuote.acceptedName` and `decidedAt`. **`supersededAt` declined:** a replaced version's link answers 422 `QUOTE_LINK_CLOSED` `REPLACED` with nothing of the quote (ADR-0087), so the field would always be null.
- **CR-058:** done in #117 (B10 continued 3b, A-323) and kept here: approval never makes a link (A-324 (e)); the several-links work starts only from a version its salesperson issued.
- **CR-059** (the exception report): B12's. Point 4's `QUOTE_ACCEPTED_BY_STAFF` is added to the planned `ExceptionKind` here, with its source event; the rest (review, the other four kinds, the seed) **named for the parent session to schedule with B12**.
- **CR-060, CR-061, CR-062** (egg reports, the VAT return, report exports and their seed): RPT, B12's; **larger, named for the parent session to schedule with B12**.
- **CR-053 to CR-057:** B11's, in its opener. **CR-050 part 1, CR-051, CR-052:** lane A's POS.
- **CR-045, CR-046, CR-048, CR-049:** answered in B10 to B10 continued 2. Older requests are answered in their phases.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration (`vitest --project unit --project integration --coverage`), on `main` at `43a1174` (main had not moved, so no rebase was needed) | **3,762 passed**, 311 files, none skipped, on `98425dc`: the whole integration suite once, lane A's POS, till and sync suites and every BIL, PAY, WHL and QUO suite among them. Statements 94.09 percent, branches 83.92 (the gate is 80), functions 97.81, lines 97.01; every 100 percent gate held. |
| Unit alone | 1,810 passed, 152 files |
| Contract (`pnpm test:contract`) | **133 passed**, 52 files. The first contract run was red on 2 tests in 2 files, each this phase's: the operation count and the new request schema missing from the walk; fixed before the next run. |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate` | Clean |
| CI on `98425dc` (before this report) | push 45091263328 success, pull_request 45091289640 success |

## Notes for the frontend track

- **2.21.0:** "Send the link again" is `issueQuoteVersion` on the issued version with `channels: []`; show the token once and keep `acceptanceLinkId` to revoke it by. The quote page can list `currentVersion.links` with their `state` and offer "Revoke" on an `OPEN` one (`revokeQuoteLink`, a reason required). A revoked link's page reads as an unknown link (404).
- **The link page** can show who accepted and when (`acceptedName`, `decidedAt`).
- **The shop's account** can list the customer's quotes (`listMyQuotes`); `documentUrl` is null until B10 continued 5.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B10 continued 5, copied from `docs/prompts/session-openers.md` (inserted by this phase's split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md, and "Two lanes" below.
List docs/sessions/ and read only the most recent report (docs/sessions/B10c4-quote-pipeline.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-QUO-007 and FR-QUO-013 of the QUO block of docs/SRS.md (nothing else from the SRS),
docs/data-model/quo.md, the QUO card in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.12, ADR-0019, ADR-0074,
ADR-0087, scenario 2 of docs/UAT.md, and A-309 to A-327 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md
as the recipe, and hakorem-documents for the quote's document. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B10 continued 5 only, on branch b10c5-quote-document-pipeline from main, building on QUO as B10 to B10
continued 4 merged it (do not rewrite it):
1. FR-QUO-007: the quote rendered and archived as a document when a version is issued (DOC's template, the version's
   `documentId`, `PublicQuote.documentUrl` by a signed expiring URL for the link's holder and in listMyQuotes);
   archived once per version, never again on a replay or a further link.
2. FR-QUO-013: getQuotePipeline (issued, accepted, declined, expired, their value by period, and the win rate by
   salesperson and by product line), reconciling to listQuotes for the same filter (the SRS's 4, 3 and 3 give 40.0
   percent). Mind the route: `GET /quotes/pipeline` must not be read as `GET /quotes/{id}`.
3. The owner's item 3 of 2026-11-18, test-first: do not refuse to issue a quote for stock not on hand: issue it marked
   subject to stock (a field on the version and on the public quote), show the quantity available, and reserve only
   what is on hand, never more; test fully, partly and not on hand with exact quantities; LOUD on 2.12.0 (a refusal
   removed), a dated amendment to A-309. Read ADR-0019 first; if this would contradict it, stop this item and report
   the options to the parent session. Keep A-323 and A-324: approval never makes a link.
Run scenario 2 of docs/UAT.md as a dry run and record every difference, including the two rules that scenario flags for
the owner (credit check and delivery fee on a partial dispatch), decided conservatively and put to the owner. The
standing orders and the bad-debt write-off of B10 continued 3 are in it where the scenario touches them.
Stop at the gate and write docs/sessions/B10c5-quote-document-pipeline.md.
```
