# B10 continued: credit control (lane B), split before ageing, dunning and standing orders

Date: 2026-11-18 · Branch `b10c-credit-control`, from `main` at `7ef2851` (B10, #109), with `main` at `48c9226` (lane A's B09b continued 2b, #110) merged in holding the merge slot (migrations renumbered 0258 to 0261, contract 2.14.0; **the force push of the rebased branch was refused by permissions, so main was merged into the branch instead**, as the brief allows) · Status: **gate as split passed locally; the phase split at its sub-domain boundary (A-315).**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

| ID | What | Who confirms |
| --- | --- | --- |
| A-313 | **Credit control as built (ADR-0088):** (a) exposure read live, never stored: the customer's open items at every branch plus its confirmed **credit** orders not invoiced at their estimates (COD and prepaid orders extend no credit), under the account's row lock; (b) past the terms is anything outstanding one day or more past due, no due date meaning due on issue; (c) reasons in the order hold, limit, terms; (d) **the approval request takes the place of the refusal** when `confirmOrder` carries `creditOverrideReason` or through `requestCreditOverride`; without a written reason, 422 with the amounts in words; approved, `confirmOrder` is called again and confirms `OVERRIDDEN` while the override covers the same order at the same amount, no more over, for no new reason; (e) the approver holds `whl.credit.override` (Owner, Manager), never the asker; (f) no account or a closed one is `CREDIT_CHECK_UNAVAILABLE`; (g) a bounced cheque counts because its reversal reopens what it paid, no further penalty; (h) an account has a home branch, credit is judged per customer across branches. | Owner, Accountant |
| A-314 | **Accounts and holds:** (a) an account opens with a nil limit and **every limit asked, at opening too, up or down, is a `CREDIT_LIMIT_CHANGE`** approved by another Owner or Manager; (b) the price list is set through `assignCustomerPriceList`, the accounts' `priceListId` deprecated and refused; (c) **a hold is released only by an approved `ACCOUNT_RELEASE`; paying the overdue invoice does not release it on its own** (FR-WHL-008 says it does; the gate says only an Owner or Manager who did not ask): for the owner; (d) the overdue hold runs daily at 00:05 Accra, more than the threshold's days past due (seed 30), naming the oldest invoice; a manual hold by the Owner, the Manager or the Accountant; (e) an edit never changes a held account's status; (f) seed: a second Manager, Efua Boakye (invented), and three accounts with illustrative limits, each asked by one Owner or Manager and approved by another, Madina Market Traders held by the Accountant. | Owner, Accountant |
| A-315 | **The split:** credit control built; ageing, the statements' ageing summary with A-300 (i), dunning, standing orders, bad-debt write-off, QUO's remainder with the owner's QUO decisions 3 and 5 of 2026-11-18, CR-047 point 2, `whl.ageing.read` and UAT scenario 2 move to **B10 continued 2** (`b10c2-ageing-dunning-standing-orders`), before B11. | Owner |
| A-316 | **A quote line with no unit is in the sale unit** (owner, 2026-11-18, decision 2): the first unit the product is sold by on quotes, a crate for eggs; LOUD on 2.12.0. | **Approved by the owner, 2026-11-18** |

**Amended or approved this session (the owner's decisions of 2026-11-18, relayed by the parent session):** A-310, A-311 and A-312 approved; A-309 amended (Sales creating requests, an unknown cost and a negative margin each needing approval: approved; several live links on three conditions; subject to stock in place of the `STOCK_SHORT` refusal); ADR-0087 accepted. The A-309 changes that need code are B10 continued 2's (below).

**No ADR conflict.** ADR-0088 is new (proposed). ADR-0017 (one maker-checker mechanism, the database's `decided_by <> requested_by`) and ADR-0085 are followed, not changed; ADR-0087 is now accepted.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B10 continued, lane B (`b10c-credit-control`, from `main`).
2. **Scope:** business accounts, exposure, WHL's `OrderConfirmationPolicy` with CR-046's override, the hold and the overdue hold, CR-048's roles with a second Owner or Manager in the seed, A-212 (d); split early, as the parent session advised, before ageing, dunning, standing orders and QUO's remainder.
3. **Gate (as split):** a credit limit blocks with an audited override by a different person, exact to the pesewa at the limit, one pesewa over and past terms by one day; exposure ties to SQL sums from the owning tables; an account past the overdue threshold is held and released only by an Owner or Manager who did not ask; every write refuses the wrong role. (Ageing as at a date moves to B10 continued 2 with the rest of FR-WHL-009 to FR-WHL-011.)

## The owner's decisions of 2026-11-18, answered

1. **Request numbers by the frontend's `main`:** done; main still at `81525f1`: CR-045 to CR-049 the quote and wholesale requests, CR-050 lane A's drop witness.
2. **A quote line with no unit is priced per crate:** **built** test-first (seen red: `EGG`, 2.000, 220; then green: `CRATE`, 2.000, base 60.000, 6,000, line 12,000), LOUD in 2.14.0, A-316.
3. **Several live links per version on three conditions:** recorded (A-309 (e), ADR-0087 accepted); **not built here:** the per-link revoke and the three mutation-checked tests are B10 continued 2's first QUO item, written into its opener with the owner's words. (B10 already closes every link when a version is replaced or expires and accepts once per version by `uq_quote_acceptance_version`; the revoke does not exist yet.)
4. **Sales may create requests for quote:** approved; nothing to change (built in B10).
5. **A-309:** unknown cost and negative margin approvals approved; **subject to stock not built here**: it changes QUO's issue and reservation and needs ADR-0019 read first, so it is in B10 continued 2's opener with the owner's words and the stop condition. A dated amendment to A-309 records the decision.
6. **A-310, A-311, A-312 approved; ADR-0087 Accepted** with its index row: committed as its own docs commit (`31e68a9`).

## Contract changes

**2.14.0, minor, LOUD for `confirmOrder` on credit terms and for a quote line with no unit** (on top of lane A's 2.13.0, renumbered at the merge slot; `scripts/contract/versioning.ts` against `main`: ok; Redocly clean; `contract:generate` up to date: 485 operations from code, 163 planned, 648 in all).
- **Into code:** `listBusinessAccounts`, `createBusinessAccount`, `getBusinessAccount`, `updateBusinessAccount`, `holdBusinessAccount`, `releaseBusinessAccount`, `listCreditOverrides`. **New:** `getOrderCreditCheck` (`OrderCreditCheck`, `CreditOverrideState`) and `requestCreditOverride` (202 `CreditOverridePending`), on the order's path, served by WHL.
- **Planned shapes changed before any client used them:** `BusinessAccount` gains `branch`, `oldestOverdueDays`, `pendingCreditLimitPesewas`, `pendingRelease`; `BusinessAccountCreate` gains `branchId`, `reason`; `BusinessAccountUpdate` gains `reason`, nullable `accountManagerId`; **`priceListId` deprecated and refused**; `createBusinessAccount` may answer 202 and `updateBusinessAccount` answers 202 `CREDIT_LIMIT_CHANGE` for every limit change; **`releaseBusinessAccount` takes `whl.account.release` and answers 202 `ACCOUNT_RELEASE`**; `CreditOverride` gains `orderPesewas`, `overLimitPesewas`, `reasons`, `reason`, `requestedBy`.
- **`confirmOrder` (implemented, LOUD):** optional body `OrderConfirm` (`creditOverrideReason`); 202 `CreditOverridePending`; new 422 `CREDIT_LIMIT_EXCEEDED`, `CREDIT_TERMS_EXCEEDED`, `ACCOUNT_ON_HOLD`. A customer with no account is still `CREDIT_CHECK_UNAVAILABLE`.
- **QUO (LOUD):** a `QuoteLineInput` with no `uom` is in the sale unit (A-316).
- `ApprovalKind` adds `ACCOUNT_RELEASE`, `CREDIT_LIMIT_CHANGE`; error codes `ACCOUNT_INVALID`, `ACCOUNT_EXISTS`; the seeded role matrix gains the five `whl.*` credit permissions.

## Built

| Item | What |
| --- | --- |
| Schema | 0258 (document type `ACCOUNT_CHANGE`), 0259 (`whl.account_change`, `whl.business_account` with its guard, `whl.credit_override_request`, `whl.credit_override`; every second-person rule held by the database), 0260 (five permissions, three approval policies with step-up), 0261 (grants as CR-048's table). |
| Domain | `whl/domain/credit.ts`: `judgeCredit` (exposure, over the limit, past the terms, the hold, every reason), `availableCredit`, `holdTrigger`, `overrideCovers`; `whl/domain/time.ts`: `daysPastDue`. 100 percent under WHL's domain gate. |
| WHL | `CreditControl` (the port, the credit check, the override, its handler, `listCreditOverrides`, `whl.CreditOverrideApproved` with abuse case 14); `BusinessAccounts` (accounts, terms, hold, release, the two change handlers, the overdue hold); `AccountHolds` (the worker's `account-hold` job, daily 00:05). |
| ORD | The port's judgement (`CreditPolicyAnswer`, `requestOverrideIn`), `CreditRefusedError`, `confirmOrder`'s optional body and 202, `creditCheck` `OVERRIDDEN`, `Orders.creditOrderIn` and `uninvoicedCreditIn`; the policy list exported for WHL. Lane A's files untouched (`sale-posting.ts`, PAY's till rules). |
| BIL, MDM | `Billing.customerOpenItemsIn` (new, additive); `PartiesAdmin.priceListHeldIn` (new, additive). |
| QUO | A line with no unit is in the sale unit (A-316). |
| Seed | The second Manager (`farm-iam.ts`, additive row with the parent session's leave); `whl-accounts` (`farm-whl.ts`): Tema Cold Store, Accra Event Caterers and Madina Market Traders through `BusinessAccounts`, each limit asked and approved by different seeded people; Madina held. Nothing posts; every seeded figure unchanged. |
| Docs | ADR-0088 and its index line; ADR-0087 accepted; ADR-0026 Amendments (the split); A-313 to A-316 and the owner's approvals; `data-model/whl.md`; the WHL and ORD cards and the port table; `API.md` (WHL, the codes); `OPERATIONS.md` (the job); the threat model's abuse case 14; the changelog; the openers (B10 continued marked, B10 continued 2 inserted, B11 reads its report). |

## The gate, proved by running it

**`test/integration/whl/credit-control.integration.spec.ts` (17 tests):**
- **FR-WHL-001, CR-048:** an account asked at 500,000 answers 202 `CREDIT_LIMIT_CHANGE`, shows limit 0 and `pendingCreditLimitPesewas` 500,000; the Owner approving their own ask is `MAKER_CANNOT_CHECK`, the Accountant 403; the Manager approves and the account shows 500,000 available; `whl.account_change` in SQL names the Owner as asker and the Manager as decider; a second account is 409; `priceListId` is 422. A change down to 400,000 (with terms 14 at once) waits likewise, the Manager refused, the Owner approving; a stale version is 409.
- **Exactly at the limit:** an invoice of 500,000 less the order's total T and an order of T: the credit check answers `PASSES`, exposure equal to the SQL sum from `bil.billing_document`, `pay.payment_allocation` and `ord.sales_order`; it confirms `PASSED`; then the account shows exposure 500,000, nothing available, equal to SQL.
- **One pesewa over:** the invoice one pesewa more: 422 `CREDIT_LIMIT_EXCEEDED`, `OVER_LIMIT` "This order would take One Pesewa Over Ltd (TEST) GHS 0.01 over its GHS 5,000.00 credit limit." and `OVERRIDE_REASON_REQUIRED`; `PLACED`, nothing reserved; the check's `overLimitPesewas` 1 and exposure equal to SQL.
- **The override:** a blank reason is 400; with a reason, 202 `CREDIT_OVERRIDE` carrying `creditCheck` over by 1; confirming meanwhile answers `APPROVAL_PENDING`, asking again 422; Sales and the Accountant are 403 on the approval; the Manager approves; `confirmOrder` confirms `OVERRIDDEN`; `listCreditOverrides` shows limit 500,000, exposure 500,001, over 1, the reason, Esi Appiah as asker and the Manager as approver; audit `CREDIT_OVERRIDE_REQUESTED`, `CREDIT_OVERRIDE_APPROVED`; one `whl.CreditOverrideApproved` carrying abuse case 14 and both figures. The Owner approving their own override is `MAKER_CANNOT_CHECK`. **Covers only what was approved:** one pesewa further over after the approval, the order is refused again (GHS 0.02 over) and a new override answers over by 2.
- **A-212 (d):** a cheque that paid the invoice in full leaves exposure 0 and the order passing; reversed `CHEQUE_DISHONOURED` (asked by the Manager, approved by the Owner), the invoice is open again, exposure equals SQL and the order is one pesewa over and refused.
- **The hold (CR-048):** the Accountant holds an account (twice is `ALREADY_ON_HOLD`); its credit order is `ACCOUNT_ON_HOLD`, its cash-on-delivery order confirms; the Accountant and Sales are 403 on release; the Manager's release answers 202 `ACCOUNT_RELEASE`, `pendingRelease` true; the Manager approving it is `MAKER_CANNOT_CHECK`, the Accountant 403; the Owner approves; the credit order then confirms; the audit trail reads open, ask limit, change limit, hold, ask release, release.
- **The database:** a limit by SQL, a release by SQL, an account opened with a limit, an edited change (HK004), a change applied by its asker (23514), an override approved by its asker (23514) and an override updated (42501 for `hk_app`, HK001 beneath) are each refused.
- **Roles:** the Cashier and the Storekeeper are refused every read and write (403); Sales every account write; the Accountant opening and editing; the Owner of another branch reads nothing and holds nothing at Dodowa; a customer's session is 401.
- **The seeded people:** each seeded limit asked by one Owner or Manager and approved by another (Accra Event Caterers: Akosua Boateng then Kwabena Owusu; Madina: Efua Boakye then Akosua Boateng; Tema: Kwabena Owusu then Efua Boakye); three seeded holders each of `whl.account.manage`, `whl.account.release` and `whl.credit.override` at Dodowa; signed in over the API with the seed's password, the seeded Owner asks Madina's release, approving it himself is `MAKER_CANNOT_CHECK`, and the seeded second Manager releases it.
- **Past the terms by one day:** an invoice due today lets an order pass; the next day the order is `CREDIT_TERMS_EXCEEDED`, "Due Today Traders (TEST) has GHS 10.00 past its payment terms, the oldest 1 day overdue.", `oldestOverdueDays` 1. **The overdue hold:** 30 days past due, the job holds nothing (`oldestOverdueDays` 30); at 31 it holds the account naming the invoice "(31 days)"; a second run holds nothing again.

**Unit:** `src/modules/whl/domain/credit.spec.ts` (28 tests): exactly at the limit, one pesewa over, FR-WHL-006's 60,000 order over by 10,000, a nil limit, the largest amounts, due today, one day past due, no due date, nil outstanding ignored, both reasons, the hold first, available credit never below nil, FR-WHL-008's 13 and 14 November, the override's cover, days across the year end.

**Walks extended:** `iam/authorisation` (the nine routes and their bodies), `bil/archive-link-rollback` (0258 to 0261 rolled back and applied over the seeded farm), the contract's request schemas and operation count, `platform/seed` (nine staff, twenty seed units), `ord/orders` (its credit refusal now uses a customer with no account).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | `confirmOrder` treats a refused credit order as passed | red: 7 |
| 2 | Exactly at the limit counted as over | red: 6 |
| 3 | Past the terms only after two days | red: 1 |
| 4 | Confirmed uninvoiced orders not counted in exposure | red: 1 |
| 5 | The hold at 30 days past due, not 31 | red: 1 |
| 6 | A release applied at once | red: 3 |
| 7 | A limit applied at once | red: the suite's setup, the database refusing the limit written without its approved change (HK010) |
| 8 | The Accountant granted `whl.account.release` | red: 2 |
| 9 | Sales granted `whl.credit.override` | red: 1 |
| 10 | An override covers any amount over | green at first (no test raised the amount after approval); the "covers only what was approved" test added; red: 1 |
| 11 | WHL's asker check on the override removed alone | green: IAM's domain and both database checks still refuse the asker |
| 12 | Override: WHL's and IAM's checks and `ck_approval_request_maker_not_checker` and `ck_credit_override_checker` removed | red: 2 |
| 13 | WHL's asker check on releases and limit changes removed alone | green: IAM and the database still refuse |
| 14 | Releases and limits: WHL's and IAM's checks and both database checks removed | red: 5 |
| 15 | `ck_account_change_checker` alone removed | red: 1 |

## Test first, as it honestly happened

- **Red first:** `credit.spec.ts` (module missing) before `credit.ts`; the gate spec's first run, once the code compiled, was 12 of 12 red, for my own defects (the version column not moved on update, a date format, `hk_app`'s privilege on a ledger row), each fixed before the next run; the QUO unit test red before its change.
- **Not red first:** the seeded-people test and the contract shape test were written after their code; mutations 8, 14 and 15 prove the role and second-person tests bite.
- **Nothing was re-run to turn red into green; no assertion was weakened and nothing was skipped.**

## Security review (hakorem-security-review)

- **Boundary:** TB2 (back office) and the database. Standards run item by item; identity, sessions, uploads, webhooks and exports not applicable (no login, upload, webhook or export change).
- **Authorisation:** every handler authorises first, deny by default, then at the account's or the order's branch; the identifier walk covers the nine routes; maker never checker in WHL's handlers, IAM and the database (three constraints, mutation-checked). **Input:** strict zod, a reason required and not blank, `priceListId` refused. SQL parameterised only. **Money:** integer pesewas, compared exactly; exposure read under the account's lock at serializable isolation. **Logging:** no personal data beyond names in audit; no secret.
- **Abuse:** case 14 (a credit sale beyond the limit to a favoured customer) is now blocked at confirmation, its override visible on `listCreditOverrides` and in `whl.CreditOverrideApproved` (abuse case 14, `CREDIT_OVERRIDE`) for the daily report (B12); a limit raised or a hold released by one person is refused. Threat model row 14 updated.

## Deferred (to B10 continued 2 unless named)

Ageing as at a date and FR-WHL-009's ageing summary with A-300 (i) (deposits on statements: to be decided the conservative way there and flagged), dunning, standing orders, bad-debt write-off, `whl.ageing.read`, QUO's document, pipeline and `listMyQuotes`, the owner's QUO decisions 3 (per-link revoke and its three conditions) and 5 (subject to stock, after reading ADR-0019), CR-047 point 2, UAT scenario 2's dry run with its two owner questions (credit check and delivery fee on a partial dispatch). Sends stay B11's.

## Contract requests (the frontend's `main` at `81525f1`)

- **CR-046** (an order past the limit or the terms): **implemented**, with one difference kept and stated: the approval request takes the place of the refusal when a written reason comes with `confirmOrder` (as the owner worded it for B10) as well as through `requestCreditOverride`; without a reason the refusal is as asked (the three codes, the amount over in words). `OrderCreditCheck` adds `reasons` (every reason, for "both") and the outcome `NO_ACCOUNT`. `CreditOverride` gains the fields asked.
- **CR-048** (who quotes, holds, releases and approves): **implemented** as its table, with `whl.ageing.read` left to B10 continued 2 (no ageing operation yet); release takes `whl.account.release` (202 `ACCOUNT_RELEASE`); every limit change is 202 `CREDIT_LIMIT_CHANGE`; the seed's second Manager.
- **CR-045** (a quote line's unit): the unit left out now means the sale unit (owner, decision 2). Its other difference (`NO_CONVERSION` in place of `REFERENCE_NOT_FOUND`) stands from B10.
- **CR-047** point 2 (`PublicQuote.acceptedName`, `decidedAt`): **B10 continued 2** (QUO's remainder); `supersededAt` stays declined (a replaced link answers no quote, ADR-0087).
- **CR-049:** built in B10. **CR-050:** lane A's. **Everything else:** answered in earlier phases or lane A's.

## Tests (this machine, 2026-11-18)

| Layer | Result |
| --- | --- |
| Unit and integration, merged (`pnpm test:coverage`), on the code with `48c9226` merged in (the same tree as the rebase) | **3,572 passed**, 295 files, none skipped. Statements 94.07 percent, branches 83.94 (the gate is 80), functions 97.79, lines 96.94; every 100 percent gate held, WHL's domain (`credit.ts`, `time.ts`, `statement.ts`) included. Before it, on `8ae73eb`: 3,528 passed, 290 files. |
| Contract (`pnpm test:contract`) | **130 passed**, 49 files, on the same code, with the new `test/contract/b10c/credit-control.contract.spec.ts`. |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no warning), `contract:generate`, versioning against `main` | Clean. |
| End to end, setup, the image, the scans, the last migration rolled back and applied | Run in CI: green on `8ae73eb` before main was merged in (runs 44321539115 push, 44321831843 pull_request); the final head's runs are named in the closing message. |

**The first full merged run was red on 6 tests in 2 files**, each a consequence of this phase, fixed before the next run and never re-run to green: the order suite's credit refusal used the seeded Tema Cold Store, which now holds an account (it now uses a customer with none), and the seed suite counted eight staff and nineteen units (now nine and twenty). The versioning check against `main` was red on the removed planned `priceListId` (kept, deprecated and refused instead).

## Notes for the frontend track

- **2.14.0:** the account screens can use the seven WHL operations; show `pendingCreditLimitPesewas` and `pendingRelease` as waiting for an Owner or Manager other than the person who asked; release is 202.
- **The over-limit order:** read `getOrderCreditCheck` for the figures; confirm with `creditOverrideReason` (or `requestCreditOverride`) to ask the override; a 422's `details[].message` names the amounts in words; after approval, confirm again.
- **Quotes:** a line with no `uom` is now in the sale unit (a crate for eggs).

## CI

- **The code head** (pull request below): every run on it is named in the session's closing message to the parent session, with its event and conclusion; the pull request merges only when every run on its head is green.
- **This report's own commit:** a report cannot name the runs of the commit that adds it, so they are named in the session's closing message.

## Next session

B10 continued 2, copied from `docs/prompts/session-openers.md` (inserted by this phase's split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md, and "Two lanes" below.
List docs/sessions/ and read only the most recent report (docs/sessions/B10c-credit-control.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
On the frontend's main at 81525f1 (A-312): CR-047's remaining point 2 (PublicQuote.acceptedName and decidedAt)
and CR-048's `whl.ageing.read` are this phase's to implement or decline; check the numbers again on main.
For this phase, read the WHL requirement block of docs/SRS.md and FR-QUO-007 and FR-QUO-013 of the QUO block (nothing
else from the SRS), docs/data-model/whl.md and quo.md, the WHL and QUO cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL
section 5.12, ADR-0085, ADR-0087, ADR-0088, and A-300 and A-309 to A-315 in docs/ASSUMPTIONS.md. Use
docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B10 continued 2 only, on branch b10c2-ageing-dunning-standing-orders from main, building on WHL and QUO as
B10 and B10 continued merged them (do not rewrite them): ageing by Current, 1 to 30, 31 to 60, 61 to 90 and over 90
days computed from invoice due dates and allocations, as at a date taken as input (ADR-0067: no now() in business SQL,
no fixed dates in tests), by customer with a total over the filter (getAgeingReport, listOpenItems as it stands),
asserted against SQL sums from BIL's and PAY's own tables and tied to 1200; FR-WHL-009's ageing summary added to
customer statements additively, and decide A-300 (i), money held on deposit for the customer (2200), the most
conservative way, recorded and flagged for the owner; dunning levels and notices (FR-WHL-011: each level once per
invoice, an opted-out channel skipped; sendStatement and the sends stay B11's, so a notice is queued through the outbox
for NTF); standing orders and their runs (FR-WHL-004, one order per standing order and date, a held account's run
recorded as skipped); bad-debt write-off (FR-WHL-012) if it fits, else to the backlog with its reason. A bounced cheque
counts against the customer's standing as B10 continued built it (A-212 (d), A-313 (g)).
QUO's remainder (FR-QUO-007, FR-QUO-013): the quote rendered and archived as a document when a version is issued
(DOC's template, `documentId` and `PublicQuote.documentUrl`), getQuotePipeline (win rate by salesperson and product
line, reconciling to listQuotes) and listMyQuotes (a customer's own quotes only; another customer's quote id opens
nothing).
The owner's decisions of 2026-11-18 for QUO (A-309 as amended), each test-first:
1. Built in B10 continued (A-316): a quote line with no unit is in the sale unit. Nothing to do.
2. Several live links per quote version are approved provided all three hold, each tested and mutation-checked: (a)
   each link can be revoked on its own and the others keep working (build a per-link revoke if none exists: authorised,
   wrong-role tested, joined to the identifier walk); (b) the quote is accepted only once across all its links, a second
   accept through another link refused; (c) every link of a version stops working when that version is replaced,
   accepted or expires.
3. Do not refuse to issue a quote for stock not on hand: issue it marked subject to stock (a field on the version and on
   the public quote), show the quantity available, and reserve only what is on hand, never more; test fully, partly and
   not on hand with exact quantities; LOUD on 2.12.0 (a refusal removed), a dated amendment to A-309. Read ADR-0019
   first; if this would contradict it, stop this item and report the options to the parent session.
Run scenario 2 of docs/UAT.md as a dry run and record every difference, including the two rules that scenario flags for
the owner (credit check and delivery fee on a partial dispatch), decided conservatively and put to the owner.
Stop at the gate and write docs/sessions/B10c2-ageing-dunning-standing-orders.md.
```
