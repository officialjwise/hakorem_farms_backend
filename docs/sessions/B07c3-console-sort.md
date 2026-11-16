# B07 continued 3: server-side sort on the console lists (CR-019)

Date: 2026-11-16 · Branch `b07c3-console-sort`, from `main` (`39fd839`) · Status: **gate passed. Six of CR-019's sixteen fields are declined with their reasons (A-181); the other ten are built.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-180 | **How the sort is applied to the four console lists, each the most conservative reading (ADR-0054).**<ul><li>**(a) Default order unchanged:** with no `sort` each list answers exactly as before, with the same cursors. The default is none of the sort fields, so it is not a `sort` value.</li><li>**(b) Parameters:** `sort` alone sorts ascending; `direction` without `sort` is refused (400 `SORT_NOT_ALLOWED`), a refusal that can be relaxed later.</li><li>**(c) Values:** `name`, `category` and `identifier` ignore case; `category` is the category's name, joined inside MDM's own schema with both sides indexed; a stock line's tie-breaker is its location, product and unit ids as text in byte order, the list's own default order.</li><li>**(d) Cost:** `valuePesewas` is shown to every holder of `inv.movement.read`, so that is the cost permission ADR-0052 asks for; a role without it is refused any sort (403) before the sort is read. No new permission.</li><li>**(e) Stock on hand:** the sorted page is read in SQL with the same scopes and filters (the category's products through MDM's published `productIdsInCategoryIn`); the total still covers every matching line.</li></ul> | Owner |
| A-181 | **Six fields declined, each 400 `SORT_NOT_ALLOWED`:** product name on `listStockOnHand`, `listStockUnits` and `listStockMovements` and location name on `listStockOnHand` (MDM's columns: INV can neither index them nor join MDM's tables); `valueAtCostPesewas` on `listStockOnHand` (each line's share of its pool by `allocate`) and on `listStockUnits` (the sum of the unit's pools), computed when read. Parked as BL-062 and BL-063. | Owner; frontend track |

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B07 continued 3 (`b07c3-console-sort`, from `main`).
2. **Scope:** CR-019's `sort` and `direction` on `listProducts`, `listStockOnHand`, `listStockUnits` and `listStockMovements` through the shared keyset, an index per allowed field in each module's own migration, default orders unchanged and shown in the examples.
3. **Gate:** each list takes its fields through the shared keyset, each field indexed, any other field 400 `SORT_NOT_ALLOWED`; each list pages without skipping or repeating through ties and rows inserted between pages, proved per list; each example shows its default order; every read still refuses the wrong role and the Farm hand still sees no cost.

## Contract changes

**Version 1.33.0, minor. No field removed, renamed or retyped; nothing a client sends made required; no default order changed.**
- **Counts:** 317 operations from code, 318 planned, 635 published (unchanged).
- **New optional query parameters** `sort` and `direction` (`asc`, `desc`) on `listProducts` (`name`, `sku`, `category`, `status`, `updatedAt`), `listStockOnHand` (`onHandQty`), `listStockUnits` (`identifier`, `expiresOn`), `listStockMovements` (`occurredAt`, `valuePesewas`). Any other value, or `direction` alone, is 400 `VALIDATION_FAILED` with detail `SORT_NOT_ALLOWED` (until now an unknown parameter was ignored); a cursor from another sort or the unsorted list is 400 `INVALID_CURSOR`.
- **Descriptions** state each list's fields, tie-breaker and default order.
- **Examples reordered, rows unchanged:** `listProducts` and `listStockMovements` newest first by id, `listStockOnHand` by location, product and unit id; `listStockUnits` was already in id order.
- **Checks:** changelog entry and cold-read line written; Redocly lint clean, no warnings; `contract:generate` matches the committed file.

## Built

| Area | What |
| --- | --- |
| Platform | `keyset-sort.ts`: `SortFields` (an allow-list with no default field), `requestedSort` (null keeps the list's default; a direction without a field is refused), `keysetComparisons` (the keyset condition as data, for Drizzle) and `orderByOf`; `keysetClause` now renders the same comparisons. `SortRequest` for the two query parameters. |
| Migrations | **0120 (MDM):** `ix_product_sort_name`, `_sku`, `_category`, `_status`, `_updated`, each ending in `id`, over live rows; `ix_category_sort_name`. **0121 (INV):** `ix_stock_balance_sort_on_hand` (branch, quantity, the line key `COLLATE "C"`), `ix_stock_unit_sort_identifier`, `ix_stock_unit_sort_expiry` and `_expiry_desc`, `ix_stock_movement_sort_occurred`, `ix_stock_movement_sort_value`. Indexes only; rollback by `DROP INDEX`. |
| MDM | `ProductCatalogue.list` takes the sort; `ProductStore.listSorted` (Drizzle, keyset through `keysetComparisons`); the filters moved into `filterClauses`, shared by both orders. `MasterDataRefs.productIdsInCategoryIn`. |
| INV | `StockMovements.list`, `StockQueries.listOnHand` and `listStockUnits` take the sort; `movementsSorted`, `onHandSorted` and `stockUnitIdsSorted` in the stores, their filter SQL shared with the unsorted queries. |
| Interface | `sort` and `direction` in the four zod query schemas (any text up to 40; the shared sort refuses). |
| Docs | `API.md` section 5 (the console lists' table); `CONTRACT_CHANGELOG.md`; ADR-0054's "Applied" note and verification; `mdm.md` and `inv.md` index notes; MDM and INV cards in `MODULE_BOUNDARIES.md`; A-180, A-181; BL-057 marked built, BL-062, BL-063; the openers' table row and B8's contract request line (read from the frontend's `main`, as CLAUDE.md says). |

## Decisions

- **No new ADR.** ADR-0054 is applied as written; its two additions to the mechanism are recorded in its "Applied" note. No ADR conflict: ADR-0008 and ADR-0011 are why six fields are declined; ADR-0052 holds (no cost reaches a role that cannot read it; the Farm hand's `/care/` reads are untouched and take no sort).
- **The expiry has an index per direction:** the nulls-last flag runs ascending both ways, so one index cannot serve the descending order unsorted.
- **No seed change:** sorting adds no data; the seeded farm answers the new parameters as it is.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`git -C ../frontend show origin/main:docs/CONTRACT_REQUESTS.md`); it lists CR-001 to CR-021.
- **CR-019: implemented for ten of its sixteen fields (1.33.0).** Declined with reasons (A-181): product name on the three stock lists, location name on stock on hand (MDM's columns; INV cannot index or join them), `valueAtCostPesewas` on stock on hand and stock units (computed from the cost pools when read). Each declined field answers 400 `SORT_NOT_ALLOWED`; BL-062 and BL-063 name what would make them possible.
- **CR-005:** standing decline, unchanged (named empty examples on every list).
- **CR-001 to CR-004, CR-006 to CR-018, CR-020, CR-021:** answered in earlier phases (the last two in B06r, 1.31.0); nothing new is asked of them.

## Security review (hakorem-security-review)

Written into the pull request. `docs/security/SECURE_CODING_STANDARDS.md` run item by item.
- **Boundary:** TB2 the back office; TB8 the database.
- **Input:** `sort` and `direction` are checked against a code allow-list (`hasOwnProperty`, so `toString` and the like are refused); the request's text never reaches the SQL; cursor values are bound parameters with a cast.
- **Authorisation:** unchanged and first: each handler authorises before reading the sort; scopes narrow the sorted queries exactly as the unsorted ones (proved for a cold-room grant on all three stock lists); Cashier, Sales, Farm hand and Driver are refused every sorted stock read (403), a user with no grant every sorted product read.
- **Data:** no new field is shown to anyone; sorting by a cost needs the permission that already shows it.
- **Not applicable:** identity, sessions, money paths, webhooks, uploads, exports, encryption (none touched). **Abuse paths:** none added or changed; no exception item.

## Deferred

- **BL-062:** sorting INV's lists by product and location names (needs an INV projection of MDM names kept by events, with its ADR).
- **BL-063:** sorting by value at cost (needs the value stored on the listed row by the valuation trigger).

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,025 passed** (4 new in `src/platform/http/keyset-sort.spec.ts`: `requestedSort` and `keysetComparisons`). |
| Integration | **1,010 passed**, 48 new: `mdm/product-sort` (21: the default order, ten walks, the category default, filters, refusals, cursors, the no-grant user, five planner checks) and `inv/console-sort` (27: three defaults, ten walks, values and total, filters and scopes on each list, nulls last, the Accountant, refusals, cursors, the four refused roles, five planner checks). |
| Coverage, merged | 2,035 passed. Statements 93.42, branches 83.04 percent (gate 80). Every 100 percent gate holds, including `src/platform/http/keyset-sort.ts`. |
| Contract | **75 passed**. Updated: `b5/inventory` (sorted stock on hand with its next page, units and movements against their page schemas; a refused sort in the error envelope) and `b3/slice-and-login` (a sorted product page; a refused sort). |
| Lint, typecheck, Redocly, `contract:generate` | Clean |
| End to end | CI only |

**Test first, honestly:**
- Both integration specs were written before the code and seen red: 14 of 16 product tests and 16 of 22 stock tests failed (the sort was ignored; the passing ones were the default orders and the 403s, which already held). The planner tests were added after the code.
- **Mutation check:** with the tie-breaker removed from `requestedSort`'s order, every walk over a field with ties went red: products by name, category, status and updatedAt both ways (9 tests including the category default), stock on hand both ways, stock units by identifier and expiry both ways, movements by time and value both ways (19 tests). Products by `sku` stayed green, since SKUs are unique among live products. Restored.
- **Failures before green:** a lint refusal (`limit + 1` beside Money, replaced by `pageProbe`); the descending expiry order not served by its index (a second index added); the expected on-hand keys first read from `inv.stock_balance` instead of the physical view (test fixed).
- **Flaky tests:** none seen. Nothing skipped, loosened or retried.

## Gate

**Passed.** Proved over the real API (`test/integration/mdm/product-sort.integration.spec.ts`, `test/integration/inv/console-sort.integration.spec.ts`):
- **Each list pages without skipping or repeating:** every allowed field, both directions, two rows a page, through long runs of tied names (case aside), SKUs, categories, statuses, update times, quantities, identifiers, expiry dates (some none), times and values, with new products (two per page) and new stock (a lot, an animal and an egg receipt per page, all tied) arriving between the first pages. Every original row is seen exactly once in the one-shot database order, and no row twice.
- **Defaults unchanged:** without `sort` each list equals its old order (products and movements by id descending, units by id, stock on hand by line key).
- **Each field indexed:** with sorting and sequential scans priced out, the planner reads each field's index in both directions with no Sort node (the category's name and the product's category each have theirs).
- **Refusals:** fields outside the list, other module's names and values at cost, a bad direction and a direction alone are 400 `SORT_NOT_ALLOWED`; a cursor across sorts or from the unsorted list is 400 `INVALID_CURSOR`.
- **Stock on hand sorted** answers the same lines, values at cost and total as unsorted; keeps the category and expiry filters and a cold-room grant's scope; units and movements keep theirs.
- **Wrong roles:** Cashier, Sales, Farm hand and Driver are refused `sort=valuePesewas`, `valueAtCostPesewas`, `onHandQty` and `expiresOn` with 403 in the handler; a no-grant user is refused a sorted product list; the Accountant may sort movements by value (145,000, 120,000, 120,000 first).
- **Examples** show each default order (contract fragments; contract tests check sorted pages against the schemas).

## Notes for the frontend track

- Send `sort` and `direction` on the four lists for the fields above and drop the "this page only" label for them; restart without a cursor when the sort changes.
- Keep page-only sorting (with its label) or no sorting for the declined fields; they answer 400 `SORT_NOT_ALLOWED`.
- Never send `direction` without `sort`.
- The three reordered examples: a mock fixture that relied on their old row order must follow.

## CI

CI ran on `044fac5`, the pushed head before this report (pull request #48), and these are every run that exists for it:
- run 43799265935, `push`, success;
- run 43799298235, `pull_request`, success (the run that compares the contract with `main`).

A commit cannot name its own runs, so the runs on the final head (this report's commit) and `main`'s `push` run on the merge commit are listed in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B8, copied from `docs/prompts/session-openers.md`.

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
