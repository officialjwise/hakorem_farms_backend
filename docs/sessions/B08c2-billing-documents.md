# B08 continued 2: billing documents, credit and debit notes, and the receivables figures

Date: 2026-11-16 · Branch `b08c2-billing-documents`, from `main` (`a24022b`) · Status: **gate passed for the part built; the phase split before rendering and the archive (A-201).** The remainder is **B08 continued 2b**, opened before B9a.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-200 | **Billing documents as built (ADR-0060).** (a) A document is issued on today's business date, never backdated, and posted on it or not at all; an INVOICE needs a customer, a walk-in RECEIPT is held on 1200 against one walk-in customer party; `issueIn` authorises nothing (the selling command has). (b) `bil.InvoiceIssued` credits each line's income at net plus discount plus price variance (resolved less agreed, each extended once), the variance to 4210 and the discount to 4220 as the line shows them, also on a tax-inclusive line; a line with no product goes to GL group `OTHER` (4030). (c) Every credit note raised on its own waits for `CREDIT_NOTE` approval by the Owner or the Manager, never its maker, with step-up, whatever its amount (threshold is data); by quantity or amount in the original's terms, recomputed by the original's tax scheme version, never more than a line or the original has left; a `REFUND` or `RETURN` reason; raised by the Owner or the Accountant; a rejected one stays a numberless DRAFT. (d) A debit note is issued at once by the Owner or the Accountant with a new `BILLING_ADJUSTMENT` reason (`UNDERCHARGED`, `CHARGE_OMITTED`), taxed by today's scheme, due on the original's due date or today. (e) `bil.document_settlement` is kept by a trigger (allocated 0 until PAY, B9a); the receivables tile answers 1200's balance (a credit balance as 0) and the outstanding amount of documents due before today, never above outstanding; reading is for the Owner, Manager, Accountant, Sales and Cashier at the whole branch. (f) A line snapshots the stock unit's identifier, so BIL never reads INV. | Accountant (b, c, d), Owner (c, e) |
| A-201 | **B08 continued 2 split before rendering and the archive (ADR-0026 Amendments).** Templates, rendering, the archive, reprints and send, the nightly numbering audit's hash check, customer statements and the supplier remittance advice are B08 continued 2b; `issueProforma` (it needs the order record) moves to B9a. | Owner |

Still open, proceeded on as stated: A-033 (registration: `tax.registered` is honoured as data; an unregistered business gets zero rows, "0" rate), A-034 (imported inputs: data in a new scheme version, no billing change), A-062 (certified totals: the fields exist, null without an adapter), A-024 to A-029, A-182 to A-199. A-020 is confirmed.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B08 continued 2 (`b08c2-billing-documents`, from `main`), split at the BIL and DOC boundary as the opener allows: billing here, rendering and the archive in B08 continued 2b.
2. **Scope:** billing documents (invoice, receipt, proforma, credit note, debit note) with levy rows from MDM's calculator, numbered in the issuing transaction through the in-transaction port `Billing.issueIn` B9a will call; their three ◆ events with rules and exact-amount tests; the fourth levy as data only; the seeded documents; the receivables figures and `getReceivablesTile`.
3. **Gate:** an invoice, credit note and debit note post exact levy lines through the ledger, and a fourth levy added as data only gives four levy lines and four subledger postings; numbers stay gap-free under concurrent issue (and a caller's rollback leaves the series contiguous); an issued document is immutable in the database; the trial balance still sums to zero on the seeded trading day; every write and the tile refuse the wrong role. (The reprint and archive items move to B08 continued 2b's gate.)

## Contract changes

**1.39.0, minor** (`docs/CONTRACT_CHANGELOG.md`). `listBillingDocuments`, `getBillingDocument`, `issueCreditNote`, `issueDebitNote` and `getReceivablesTile` move into code with descriptions and `x-error-codes`; `getOwnerDashboard`'s receivables leave `pendingFigures`; `listReasonCodes`' `domain` filter takes `BILLING_ADJUSTMENT`. **No existing shape changed:** no schema edited, no field removed, renamed, retyped or made required. New error code `BILLING_DOCUMENT_INVALID`; `CREDIT_NOTE_EXCEEDS_ORIGINAL` now raised. 359 operations from code, 276 planned; `contract:generate`, Redocly clean.

## Built

| Area | What |
| --- | --- |
| Migrations | 0145 (document types PRO, INV, RCP, CRN, DBN; `platform.number_allocated`, a shared read-only function); 0146 (MDM reasons `BILLING_ADJUSTMENT`); 0147 (schema `bil`: `billing_document`, `billing_document_line`, `billing_document_line_tax` DOCUMENT, `document_settlement` PROJECTION, `pub_document`; `ck_billing_document_status`, `_frozen`, `_line_frozen`, `_totals`, `_number`, `_original`, `_credit_cap`); 0148 (FIN: the three events, rules 70 to 83, `uq_journal_entry_billing`, `fin.pub_receivable_balance`); 0149, 0150 (`bil.document.read`, `bil.credit_note.create`, `bil.credit_note.approve`, `bil.debit_note.create`; the `CREDIT_NOTE` policy). |
| BIL | `domain/billing.ts` (line anchor, variance, totals, levy totals, series lock key, the issue rules, credit line planning, note reasons), `Billing` (`issueIn`, `seriesLocksFor`, list, get, credit and debit notes, the `CREDIT_NOTE` approval handler), `PgBillingStore`, `BillingController`, four fragments, `BilModule` (declares the ◆ events). |
| FIN | `invoiceIssuedAmounts`, `creditNoteIssuedAmounts`, `debitNoteIssuedAmounts`, `WALK_IN_CUSTOMER`; the three translators in `LedgerPostings`. |
| MDM | `MasterDataRefs.customersIn`. |
| RPT | `receivablesFigures`, the store's two published-view reads, `getReceivablesTile`, the dashboard's receivables live. |
| Seed | `bil-documents`: invoice to Tema Cold Store (124,489 on 30 days), walk-in receipt (18,500), credit note 36,000 approved by the Manager, debit note 2,400, proforma to Accra Event Caterers. No stock moves. |
| Docs | ADR-0060 and its index row; A-200, A-201; ADR-0026 amendment; `bil.md`, `fin.md`, `platform.md`, `mdm.md`; BIL, FIN and RPT cards; `API.md`; the changelog; THREAT_MODEL case 31 (`CREDIT_NOTE`); the openers (B08 continued 2b inserted, B9a updated). |

## The gate, proved by running it

1. **Exact levy lines through the ledger.** `bil/billing-documents`: the inclusive 42,560 meat line stores net 35,467, VAT 5,320, NHIL 887, GETFund 886, the goat three `ZERO_RATED` rows at 0; the invoice posts Dr 1200 122,560 (Tema), Cr 4010 35,467, Cr 4000 85,000 (resolved), Cr 2100 5,320 / 887 / 886 each against its levy, Dr 4210 5,000. A credit by quantity of that line posts Dr 4200 35,467, Dr 2100 5,320 / 887 / 886, Cr 1200 42,560. A debit note of 10,000 (inclusive) posts Dr 1200 10,000, Cr 4030 8,334, Cr 2100 1,250 / 208 / 208. Unit: each row's amounts and balance (`event-amounts.spec.ts`).
2. **A fourth levy is data only.** `bil/fourth-levy`: a levy `COVID` and a scheme version made through MDM's `TaxAdmin` and approved by the Owner; the next invoice of 40,000 shows VAT 6,000, NHIL 1,000, GETFund 1,000, COVID 400 and the ledger four 2100 lines against four parties; the earlier invoice keeps three. No code or table changed.
3. **Gap-free under concurrent issue, and a rollback returns the number.** A caller that throws after `issueIn` leaves the series exactly as it was and the next issue takes the same number; 200 receipts issued by eight concurrent issuers, 25 rolled back after allocation, leave 175 numbered consecutively from 1, allocations equal to `next_value - 1`, one journal each, `NumberSeries.gapsIn` empty.
4. **Immutable, held by the database.** As hk_app: an update of an issued document's gross, customer name or status, of its lines or levy rows, is HK004; a delete is refused (no grant); the content hash is set once; at commit an issue with totals off its lines (`ck_billing_document_totals`) or a number not allocated to it (`ck_billing_document_number`) is refused; a credited amount above gross (CHECK) or not equal to its credit notes (`ck_billing_document_credit_cap`) is refused.
5. **A credit note waits for a different person and never exceeds the original.** 202 `CREDIT_NOTE`, nothing numbered or posted; the maker's approval 403; the Manager's approval issues `CRN-…`, posts it, and the original shows 56,240 of 86,240 left; a further 60,000 is 422 `LINE_ALREADY_CREDITED`; the event carries the approval and `abuseCases: [31]`.
6. **The trial balance still sums to zero on the seeded day.** `fin/trial-balance`: every seeded billing event has its entry, debits equal credits and the signed sum is exactly 0 with the five billing documents in the seed.
7. **Every operation refuses the wrong role.** Storekeeper, Farm hand and Driver are refused all four BIL operations and nothing is written; Cashier and Sales read but neither credit nor debit; the Manager cannot issue a debit note; an Accountant of the test branch can neither read nor correct a Dodowa document and lists none; `rpt/receivables`: the Storekeeper, Cashier, Sales, Farm hand and Driver are refused the tile; the handler walk refuses a user with no grant on all five.
8. **Receivables live.** `rpt/receivables`: outstanding 109,389 (equal to 1200 in SQL, and to the hand sum 124,489 + 18,500 − 36,000 + 2,400), overdue 0; 31 days on, overdue 90,889 (the invoice's 88,489 left and the debit note's 2,400). `rpt/dashboard`: the dashboard answers the same and no longer lists them as pending.

## Mutation checks (run, then removed; never committed)

| Mutation | Went red |
| --- | --- |
| M1 the deferred check trigger `trg_billing_document_check` removed from 0147 | "refuses at commit an issue whose totals are not the sums of its lines…" and "refuses a further 60,000, by the handler and by the database" |
| M2 the price variance dropped from an invoice line's sales amount | "owes the agreed gross, credits sales at the resolved amount…" |
| M3 the per-line credit cap in `planCreditLines` removed | "refuses a further credit beyond what the line has left (56,241 after 30,000 of 86,240)" |

## Security review (hakorem-security-review checklist, by hand)

Boundary: back office (staff session), the database. Authorisation: every handler authorises first, deny by default, then at the original's branch; lists only whole-branch grants; `issueIn` is an in-process port that authorises nothing, called only inside a selling command that has (ADR-0060). Maker and checker: a credit note always waits for a different holder of `bil.credit_note.approve` with step-up (IAM's check, tested). Input: strict zod schemas, parameterised SQL. Money: integer pesewas, one rounding per line, levies from the one calculator, totals as sums, held by the database. Idempotency keys on both writes; audit on issue and on submit. No external call, upload, export or webhook. **New abuse path:** a customer credit note used to take money or hide a shortage, THREAT_MODEL case 31, kind `CREDIT_NOTE`, carried on `bil.CreditNoteIssued` for B12. No finding open.

## Decisions

- **ADR-0060 (Proposed):** the in-transaction issue port with its series locks; every document rule in BIL's triggers; settlement kept by trigger until PAY; snapshots instead of reads of INV; the three posting rows as data, every levy through one determination. It adds to ADR-0003, ADR-0015 and ADR-0020 without changing their decisions. No ADR conflict; no stop.

## Deferred

- **B08 continued 2b (A-201):** templates and versions, rendering after commit (PDF and ESC/POS), `doc.archived_document` with its hash and render jobs, `archived_document_id` (expand) and `content_hash` set by DOC, reprints with their marker and `bil.reprint_log`, `sendBillingDocument`, the numbering audit's hash and orphan check, customer statements, the supplier remittance advice.
- **B9a:** `issueProforma` over the order; PAY's subscribers writing `allocated_pesewas` into `bil.document_settlement` through BIL; the sale posting calling `Billing.issueIn`.
- **B12:** the daily exception report lists `CREDIT_NOTE` (case 31).

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`648ad26`, unchanged since B08 continued 1b); it lists CR-001 to CR-021.
- **CR-005 (named empty examples on every list):** still declined as a whole and **named for the parent to schedule**: examples-only but across every list operation, larger than this phase. The new list keeps its one example.
- **CR-013 (the dashboard in one response):** advanced: the receivables figures are now answered and leave `unavailable`/`pendingFigures`; its `invoices` tile (total, paid, overdue) needs payments for "paid" and is left to B9a.
- **CR-018:** unchanged; nothing in it concerns billing.
- **CR-001 to CR-004, CR-006 to CR-012, CR-014 to CR-017, CR-019 to CR-021:** answered in earlier phases; nothing new is asked.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,215 passed** (new: `bil/domain/billing.spec.ts` 32; `event-amounts.spec.ts` +5; `rpt dashboard.spec.ts` +3) |
| Integration | **1,215 passed** in the merged coverage run (new: `bil/billing-documents` 19, `bil/fourth-levy` 1, `rpt/receivables` 3, `rpt/dashboard` +1). The first full run had 8 failures, all lists and seeded-day figures to extend for the new routes, permissions, reasons, seed unit and live receivables: the handler walk (twice), the cashier's permissions, the reason code count, the seed unit kinds, the dashboard's pending list and tile (twice), and a posting rule test that used `bil.InvoiceIssued` as its uncatalogued event (now `pay.PaymentCleared`). Fixed in the test files. |
| Coverage, merged (`pnpm test:coverage`) | **2,430 passed**, 196 files, exit 0. Statements 93.77 percent, branches 83.41 percent (gate 80). Every 100 percent gate held, `src/modules/fin/domain/**` included; `bil/domain` at 100. |
| Contract | **86 passed** (`b8/billing-documents` new; the drift test's still-planned probe moved from `listBillingDocuments` to `listInvestors`, and the request schema map gained the two note bodies) |
| Lint, typecheck, Redocly, `contract:generate --check` | Clean |
| End to end | CI only |

**Test first, honestly:** FIN's three posting functions were written after their spec, which was run red (functions missing) first. BIL's domain module was written before its spec, then specified and proved by mutation (M3); the integration tests were written before the code was run against them and failed first on real faults: the line guard trigger read `OLD` on insert (fixed in 0147), a test outside a request context, pool exhaustion with 200 simultaneous issuers holding connections (the test now issues from eight concurrent issuers, 25 each), and expired sessions after advancing the clock (the late reads go through the handler). No flaky test seen; nothing skipped, loosened or retried.

## Gate

**Passed for what was built** (A-201 moves the reprint and archive items to B08 continued 2b):
1. An invoice, credit note and debit note post exact levy lines through the ledger: **passed.**
2. A fourth levy added as data only produces four levy lines and four subledger postings: **passed.**
3. Billing numbers stay gap-free under concurrent issue, and a caller's rollback leaves the series contiguous: **passed.**
4. An issued document is immutable, held by the database: **passed.**
5. The trial balance still sums to zero on the seeded trading day: **passed.**
6. Every write and the receivables tile refuse the wrong role: **passed.**

## Notes for the frontend track

- 1.39.0: the invoice and receipt screens (F8) can read the real API. Show `levyTotals` and each line's `levies` as given, every levy including zero rows; never add them up.
- A credit note always answers 202: show it in the approvals inbox; the Owner or the Manager (not its maker) approves with step-up. Until then the list shows it as a numberless `DRAFT`.
- A credit or debit line amount is in the original's terms: say "net" when `taxInclusive` is false and "gross" when true.
- `archivedDocumentId`, `contentHash` and reprints arrive with B08 continued 2b.

## CI

CI runs are listed in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B08 continued 2b, copied from `docs/prompts/session-openers.md`.

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
