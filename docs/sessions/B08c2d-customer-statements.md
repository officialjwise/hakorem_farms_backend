# B08 continued 2d: customer statements (lane B)

Date: 2026-11-17 to 2026-11-18 · Branch `b08c2d-customer-statements`, from `main` (`17df00d`), rebased on `main` at `dfb44d2` (lane A's B09b continued #100, #99, #101, #102 and #103) holding the merge slot · Pull request [#104](https://github.com/officialjwise/hakorem_farms_backend/pull/104) · Status: **gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-300 | **Customer statements as built.** Nine points, (a) to (i), listed below. | Accountant (a, c, d, i), Owner (b, e, f, g) |

A-300's points:
- **(a) The figures** are the customer's 1200 against its `CUSTOMER` subledger party at one branch, read through FIN's `Journals.customerReceivablesIn` in the producing transaction (ADR-0085).
- **(b) One branch per statement.** `StatementCreate.branchId` is optional (additive); without it the caller must hold `whl.statement.create` at exactly one whole branch (`BRANCH_REQUIRED`), as `createOrder` does.
- **(c) A customer in credit** has a closing (or opening) balance of zero with the credit beside it (`closingCreditPesewas`, `openingCreditPesewas`), each line's running balance marked `balanceSide` `C`; the rendering prints `CR`. No separate deposit line.
- **(d) The kinds:** invoice, debit note, credit note, refund, payment, payment reversal by event and side, anything else an adjustment; refunds, reversals and adjustment debits are `otherChargesPesewas`, adjustment credits `otherCreditsPesewas`.
- **(e) Once per period:** one ISSUED statement per customer, branch and period; asking again answers the first as it stands. A draft is stored with no number and no rendering, and is never issued afterwards.
- **(f) Grants (0244):** the Owner, the Manager, the Accountant and Sales produce and read statements. The Manager is in because a Manager grants Sales and must hold its permissions (FR-IAM-022; `iam/access-admin` was red until it was). No step-up.
- **(g) A list row carries no lines** (`lines: []`); `getStatement` has them all.
- **(h) The period** ends today at the latest and spans at most 366 days; the number's year is the issue date's.
- **(i) Not on the statement yet:** the ageing summary (B10), money on deposit (2200) or store credit (2210), `sendStatement` (B11). A customer reads no statement: the operations are staff-only.

**No ADR conflict.** ADR-0085 is new (proposed); WHL importing FIN is downward (layer 10 to 4) and only WHL's card changed. A-206 is marked done.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B08 continued 2d, lane B (`b08c2d-customer-statements`, from `main` at `17df00d`).
2. **Scope:** the WHL module with customer statements only: `whl.statement`, the `STATEMENT` document type and series, `whl.statement.read` and `whl.statement.create` with grants, `listStatements`, `createStatement` and `getStatement`, the A4 template with sample data, rendering and archiving through `Documents.requestRenderIn` and a consumer of `doc.DocumentArchived`, one seeded statement. `sendStatement` stays B11's.
3. **Gate:** a statement for a period lists the customer's issued documents and their settlement and ties to 1200 for the customer's party and period (opening plus invoices and debit notes, less credit notes and payments, equals closing, to the pesewa, against SQL sums straight from `bil.billing_document` and `fin.journal_line`); it is numbered from its own gap-free series, rendered after commit and archived exactly once; every statement write refuses the wrong role.

## Contract changes

**2.7.0, minor and additive** (on top of lane A's 2.6.0). The changelog entry and its cold-read line are written.
- **Into code:** `listStatements`, `createStatement`, `getStatement`. `sendStatement` stays planned (B11).
- **New response fields:** `CustomerStatement.branchId`, `issueDate`, `openingCreditPesewas`, `closingCreditPesewas`, `otherChargesPesewas`, `otherCreditsPesewas`; `StatementLine.balanceSide`; three `StatementLine.kind` values on a response (`REFUND`, `PAYMENT_REVERSAL`, `ADJUSTMENT`).
- **New optional request field:** `StatementCreate.branchId`.
- **New error code:** `STATEMENT_INVALID` (`BRANCH_REQUIRED`, `CUSTOMER_UNKNOWN`, `PERIOD_REVERSED`, `PERIOD_NOT_ENDED`, `PERIOD_TOO_LONG`).
- **Behaviour, loudly:** a list row's `lines` is empty; asking for an issued period again answers the first statement; `documentId` is null until DOC archives it.
- **No existing shape changed.** Checks: `contract:generate` (447 operations from code, 195 planned), Redocly clean, `scripts/contract/versioning.ts` against `main`: ok.

## Built

| Area | What |
| --- | --- |
| Migrations | Renumbered at the rebase above main's 0239. 0240 the `STATEMENT` document type (`STM`); 0241 its A4 template, version 1, with sample data; 0242 the `whl` schema: `whl.statement` (DOCUMENT, `ck_statement_balances`, `ck_statement_opening`, `ck_statement_closing`, `ck_statement_issued`, `ck_statement_archive`, `uq_statement_issued_period`, `whl.statement_guard` HK004 `ck_statement_frozen`) and `whl.statement_line` (LEDGER, insert-only), with the deferred `whl.statement_check` (HK010 `ck_statement_totals`, `ck_statement_number`) on both; 0243 and 0244 the permissions and grants. 0240 and 0241 roll back over an archived statement by keeping what the archive names (walked by `bil/archive-link-rollback`). |
| FIN | `Journals.customerReceivablesIn` (read only, in the caller's transaction, authorising nothing) and two store reads on `ix_journal_line_subledger`. No posting rule, account or event changed. |
| WHL domain | `statement.ts`: `classifyLine`, `statementOf`, `numberedLines`, `judgePeriod`, `statementRenderData`; `paging.ts`. Under a new 100 percent coverage gate. |
| WHL application and interface | `Statements` (list, get, create; the consumer `whl.statement-archive-link`), `PgStatementStore`, `StatementsController`, `WhlModule` wired in `app.module.ts`. |
| Seed | `farm-whl.ts`: Tema Cold Store Ltd's statement for the thirty days to the seed's today, issued by the seeded Accountant. |
| Docs | ADR-0085 and its index line, A-300, `data-model/whl.md` and `doc.md`, the WHL and FIN cards, `API.md` (section and catalogue), the changelog, B10's opener. |

## The gate, proved by running it (`test/integration/whl/statements.integration.spec.ts`, 12 tests)

**FR-WHL-009's case at Dodowa for Akwaaba Poultry Traders (TEST):** an opening of 100,000 entered yesterday by manual journal (Dr 1200 against the customer, Cr 3900; on no billing document), invoices of 150,000 and 100,000, a credit note of 20,000 raised by the Accountant and approved by the Owner, and 150,000 taken in cash at a till in the cashier's open shift through `Payments.recordIn`.
- **Taken straight from SQL:** opening **100,000** (1200 lines before the period), invoiced **250,000** and credited **20,000** (`bil.billing_document` gross by kind), paid **150,000** (1200 credits of `pay.*` entries), closing **180,000**; 100,000 + 250,000 − 20,000 − 150,000 = 180,000.
- **The statement** answers exactly those figures and five lines: brought forward 100,000, the two invoices by their numbers, the credit note by its number, and the payment named by its journal, each with its running balance.
- **Yesterday alone** (a draft): the journal as an `ADJUSTMENT` of 100,000 and nothing of today's documents.

**A customer in credit:** an invoice of 50,000 paid at the till and then credited 12,000: SQL gives closing **−12,000**; the statement answers closing 0 and `closingCreditPesewas` **12,000**, the last line `C`.

**Numbered once, archived once:** the gate's statement has one render job QUEUED in its issuing transaction; after the worker, exactly one archive row whose SHA-256 is that of the stored bytes (which print `Closing balance GHS 1,800.00`), linked from the statement; a redelivery adds nothing. **Five concurrent requests** for one period answer one id and one number, with one issued row, one render job, one allocation and, after the worker, one archive. **Six concurrent statements** of different periods and the earlier ones are numbered 1 to n with no gap, allocations equal to `next_value − 1`, each one issued statement; a draft takes no number and no render job. A replay answers the first; a reused key with another body is 409.

**The database holds** (as `hk_app`): a changed figure or a cleared archive link is HK004 `ck_statement_frozen`; a line cannot be updated (no grant) and the owner role is refused by trigger (HK001); a forged extra line is HK010 `ck_statement_totals`; a header that does not add up is 23514 `ck_statement_balances`; a number the platform never allocated is HK010 `ck_statement_number`; an issued statement without a number is 23514 `ck_statement_issued`.

**Wrong callers:** the Cashier and the Storekeeper are refused all three operations (403); a customer's sign-in is 401 on all three; the Owner of another branch gets 403 with the envelope only on Dodowa's statement, an empty list, and 403 producing one at Dodowa, while their own branch answers the customer's empty account there. The handler walk (`iam/authorisation`) and the identifier walk (`iam/no-id-is-a-key`) cover the three operations, the latter with the seeded statement as the real identifier.

## Mutation checks (each applied alone, the statements spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | The domain reads a payment as an adjustment | red: 6 of 12 |
| 2 | `createStatement` no longer answers the issued statement of the period | red: 1 of 12 (the concurrent test) |
| 3 | `getStatement` no longer checks the statement's branch | red: 1 of 12 |
| 4 | FIN's read no longer filters by branch | red: 1 of 12 |
| 5 | `ck_statement_totals` raises a notice instead | red: 1 of 12 |
| 6 | `ck_statement_frozen` raises a notice instead | red: 1 of 12 |
| 7 | `ck_statement_balances` always true | red: 1 of 12 |

## Test first, as it honestly happened

- **`statement.spec` (12 tests):** written before the domain and seen red (module missing). It holds FR-WHL-009's case, a customer in credit, an opening in credit, other charges and credits, the largest balance, every classification and reference.
- **The integration and contract specs** were written after the application code; their first runs were red on test faults (a customer number reused, a privilege refusal read as a trigger's, two supertest calls started together). Mutations 1 to 7 prove they bite.
- **The first full merged run was red on 5 tests**, each a real gap fixed before the first commit of its code:
  1. `iam/access-admin`: the Manager grants Sales, so must hold `whl.statement.create` (FR-IAM-022); 0244 grants it (A-300 (f)).
  2. `platform/seed`: the seed has one unit more.
  3. `bil/archive-link-rollback`: the template and document type migrations (now 0241 and 0240) could not roll back over an archived statement (the archive names the template version and the document type); their down steps now keep what is named and their up steps are idempotent; the walk's bound rose from 80 to 100 steps.
  4. `doc/archive-completeness`: an archive now also belongs to an issued statement; the test checks the seeded statement is archived once and counts its render job.
  5. `platform/migration-runner`: the grant migration had been edited after the run's template was built; on the next run it passed.
- **The statements spec crossed midnight once:** a run starting at 23:58 UTC moved past midnight through its step-ups, so its dates disagreed with the server's. The spec now starts its clock after a midnight within three hours, always forward, so the file runs on one business day.

Nothing was re-run to turn red into green. Each red run above was a real gap, fixed in the code or the test it named; no assertion was weakened and nothing was skipped.

## Decisions

- **ADR-0085 (proposed):** the statement is read from the ledger's receivables through FIN's door; one branch; numbered once, archived once; WHL imports FIN.
- No new port, no new event.

## Security review (hakorem-security-review)

- **Boundary:** TB2 (back office) and the database.
- SC-01: strict zod bodies and queries (dates as ISO dates, ids as UUIDs, unknown fields refused). SC-02: every handler authorises first, deny by default, then at the statement's branch; a list shows only the reader's whole branches; another branch's Owner, the wrong roles and a customer are tested. SC-03 and SC-04: parameterised SQL only. SC-05: integer pesewas as bigint; the domain sums line integers; no number arithmetic next to `Money`. SC-06: `createStatement` takes its idempotency key; replay and reuse are tested. SC-07 and SC-08: the audit event carries ids and pesewas; no secret is logged. SC-15 and SC-16: no empty catch in TypeScript; stable codes. SC-22: statement lines are insert-only, a statement is written once. SC-23: serializable with the series lock. SC-24: produced and issued statements are audited with their figures.
- **Not applicable:** SC-09 to SC-11 (existing console routes), SC-12 (no upload), SC-13 (no webhook), SC-14 and SC-19 (no external call; rendering is DOC's worker), SC-17 (a statement moves no money and needs no checker), SC-18 (no restricted field: the customer's name and public ID only), SC-20 and SC-21 (CI's scans).
- **Abuse:** no new abuse path. A statement reads what the ledger holds; it cannot change a balance.

## Deferred

- B10: the ageing summary on the statement, and whether a customer's deposits (2200) belong on it (A-300 (i)).
- B11: `sendStatement` through NTF, and a customer's own read of their statements.

## Contract requests

The frontend's `main` was read at `4df43d7` at the start and `678f8c9` at the rebase; it holds CR-001 to CR-044.
- **CR-042, CR-043 and CR-044 (PUR):** placed by the owner in **B09u**, lane B's next phase (#99), while this phase ran; not done here. **One finding for B09u, from reading the code:** the three-way match computes `priceVariancePesewas` **per unit** (`matchLine` in `src/modules/pur/domain/three-way-match.ts`: the absolute difference between the line's and the order line's unit prices) and `qtyVariance` in the product's **base unit**, positive when the invoice charges more than is left to invoice of what was received. B09u's opener says to describe the price variance as "the line's whole difference from the order price", which is not what the code computes: B09u must either describe it per unit, or change the computation (a behaviour change on an implemented operation). The `matchSupplierInvoice` and `listSupplierInvoices` examples (20,000 for 500 head at 1,290 against 1,250) give the line's whole difference, so today the examples and the code disagree. A CR-044 description fix was written here first and taken out at the rebase, since the owner placed it in B09u.
- **CR-039, CR-040, CR-041:** placed by the owner in B11, B09c and B10.
- **CR-031 to CR-033, CR-038:** lane A's (B09b's continued parts).
- **Everything else:** answered in earlier phases.

## Tests (this machine, 2026-11-18)

| Layer | Result |
| --- | --- |
| Unit and integration, merged (`pnpm test:coverage`), on the rebased code | **3,301 passed**, 269 files. Statements 94.26 percent, branches 84.66 (the gate is 80), functions 97.77, lines 96.94; every 100 percent gate held, `src/modules/whl/domain` among them (new). |
| Contract (`pnpm test:contract`) | **122 passed**, 47 files, the new `b8/customer-statements` among them. |
| Lint (module boundaries, lint fixtures, test placement, schema names), typecheck, Redocly, `contract:generate`, versioning against `main`, the dependency audit (the owner's live waiver only) | Clean. |
| End to end, setup, the image, the scans, the last migration rolled back and applied again | Run in CI. |

**After the rebase on lane A's B09b continued,** the first full run was red in the statements spec alone (7 of 12): main now refuses cash into a till through another till's shift (`SHIFT_OTHER_REGISTER`, ADR-0077), and the spec's till payment opened its shift on no register. It opens it on the till it pays into, as lane A's specs do (`e2a336e`); the next full run is the one above.

## Gate

**Passed:** the statement ties to 1200 for the customer's party and period to the pesewa against SQL sums straight from `bil.billing_document` and `fin.journal_line`, with an opening journal and a till payment; it is numbered from its own gap-free series, rendered after commit and archived exactly once, also under concurrent requests; every operation refuses the wrong role.

## Notes for the frontend track

- **2.7.0 is additive.** The statement screens can use `listStatements`, `createStatement` and `getStatement` now; `sendStatement` stays against the mock.
- Show `closingCreditPesewas` as the credit held for the customer when it is above zero (the closing balance is then zero), and each line's balance with its `balanceSide`.
- A list row has no lines: open the statement to show them. `documentId` is null until the PDF is archived; poll `getStatement` or show "being prepared".
- CR-044 is B09u's (below): until it lands, `priceVariancePesewas` is computed per unit by the server, whatever the example says.

## CI

- **`db59f4d`** (the branch before the rebase, pushed while waiting for the merge slot): run **44207594464 (push)** succeeded. No pull request was open, so no `pull_request` run exists for it; it is superseded by the rebase.
- **`e2a336e`** (the rebased code head, pull request #104): run **44234588779 (push)** **succeeded** and run **44234632951 (pull_request)** **succeeded**. Their jobs: lint and type check; unit and integration with the coverage gate; contract (with the contract compared against `main` on the pull request run); the setup script with end to end and smoke, and the last migration rolled back and applied again; the image build and scan; the secret scan, the dependency audit (the owner's live waiver only) and static analysis.
- **This report's own commit:** a report cannot name the runs of the commit that adds it, so they are named in the session's closing message. The pull request merges only when every run on its head is green.

## Next session

B09u, copied from `docs/prompts/session-openers.md` on `main` (the parent session, 2026-11-17: lane B's next phase is B09u, then B10; this phase's opener now says so).

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
