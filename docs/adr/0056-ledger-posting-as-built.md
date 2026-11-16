# ADR-0056: The ledger's posting path, subledger sources and the journal number as built

- **Status:** Proposed
- **Date:** 2026-11-16
- **Session:** B8
- **Deciders:** backend track; the accountant reviews the seeded rules (A-029, A-182)

## Context

ADR-0003 decides that modules publish financial events and FIN posts them in the publisher's transaction from rules held as data, with a boot assertion and a nightly reconciliation as the two safeguards. ADR-0015 decides gap-free numbers from a row-locked series. Building them in B8 raised questions those ADRs leave open: how FIN reads the events of modules above it without importing them; how a correction finds the entry it reverses; how the nightly job compares an inventory account with INV's cost pools when FIN (layer 4) may not read INV (layer 5); what "declared as posting" means to the boot assertion; and how the journal number, a hot row, behaves under serializable isolation.

## Options considered

1. **FIN reads every higher module's tables or published views for the reconciliation and the event shapes.** Simple to write, but a lower layer reading a higher one breaks ADR-0008 and the `publishedViewReaders` rule.
2. **The higher modules call FIN with account codes or amounts already classified.** Breaks ADR-0003: only FIN knows accounts, and B5 to B7 would be reopened for every rule.
3. **FIN reads the published event payloads by their documented fields, publishers declare their ledger events to the event bus, and the higher module registers a subledger source with FIN (the ADR-0051 port pattern).** FIN stays the only holder of accounts, no lower layer reads a higher one, and the boot assertion can compare what is published with what is posted.

## Decision

Option 3.

- **Posting.** `LedgerPostings` (FIN) subscribes in-transaction to every code in `fin.posting_event_type`. Each handler reads the payload by its documented fields (`docs/DOMAIN_MODEL.md` section 5; FIN keeps its own interfaces of those fields, never an import of the publisher), names its amounts and determinants (the product's GL group and a reason code's loss group from MDM's `MasterDataRefs`, the supplier's name for the subledger), and calls `Ledger.postIn`. `Ledger.postIn` asserts serializable isolation, chooses the posting date by the late-event rule (FR-FIN-009, A-183), builds the lines from the rules in force on that date (`buildJournalLines`, pure, under a 100 percent coverage gate), registers the entry as a `JOURNAL` business document, allocates its number and writes the entry and lines. Any refusal throws `LedgerPostingRefusedError` (422 `PERIOD_NOT_OPEN`, `SUBLEDGER_REQUIRED` or `POSTING_RULE_MISSING`) and the publisher's transaction rolls back. All amounts zero: no entry.
- **Corrections.** `fin.journal_entry.event_subject_id` records what the event is about (a movement, an invoice, a payment). An event that names the subject it reverses (`reversesMovementId`) is posted as a `REVERSAL` entry whose lines are the original's with every side swapped, linked by `reverses_entry_id` (unique, so once). Nothing is recomputed. A reversal of a subject that posted nothing posts nothing if its value is zero and is refused otherwise.
- **Declared events.** `DomainEvents.declareLedgerEvents` records the ◆ events a module publishes; INV, PRC and PUR declare theirs at module init (`INV_LEDGER_EVENTS` equals the posting events of `inv.movement_type` plus `inv.UpkeepExpensed`, proved by a test). The boot assertion (`LedgerPostings.assertCatalogueIn`, at `onApplicationBootstrap`) refuses to start when a declared event is not catalogued, a catalogued event has no handler, an amount has no rule in force, or an event's rules post only one side. If the database cannot be reached at boot, the application starts (its health check reports the database) and the first posting runs the assertion first.
- **Subledger sources.** FIN publishes `SubledgerSources`; a higher module registers a `SubledgerSource` (name, determinant type, role, `valuesIn(tx)`). INV registers `inv.stock-value`: the cost pools summed per GL group. The nightly `ledger-reconcile` job (`LedgerReconciliation`) maps each key through `fin.account_determination` to its control account and compares the account's balance with the subledger, per account across branches (A-184); a key no determination maps is itself a break. It also checks the signed sum of the ledger, every entry's balance and line count, and every number series (`NumberSeries.gapsIn`). A finding is `fin.TrialBalanceDriftDetected` and an error log; nothing is corrected.
- **The journal number.** `JNL-<YEAR>-<BRANCH>-<SEQUENCE>` from `platform.number_series` (doc type `JOURNAL`, fiscal year of the posting date, the entry's branch), allocated by `platform.allocate_number` in the posting transaction. Two postings in one branch at once contend on the series row: under serializable isolation the later fails with 40001 and the unit of work re-runs it (ADR-0005). A command that expects contention declares the series in `seriesLocks` (`JOURNAL:<year>:<branchId>`), which queues it before `BEGIN` instead (A-186). Commands of B5 to B7 do not declare it; their volume is low.
- **Rules as data.** The seeded rule set covers the events published today (A-182); seeded rules are created by the System principal and carry no approval (`ck_posting_rule_approved`); every later rule change needs a `POSTING_RULE_CHANGE` approval (B08 continued). A session that publishes a new ◆ event adds its `fin.posting_event_type` row and rules by migration, with a matrix test of exact amounts, or the application does not boot.

## Consequences

- FIN never imports INV, PRC or PUR, and never reads their tables; INV imports FIN's public door to register its source, as ADR-0051 allows a higher module to do.
- A publisher that renames a payload field breaks FIN's posting at the first event, not silently: the handler throws and the business operation rolls back; the matrix test catches it in CI.
- Inter-branch transfers of untracked stock move pool value between branches without a journal until INV publishes `inv.StockTransferredBetweenBranches` (A-184, BL-064), so the stock reconciliation is per account, not per branch.
- Binds: `docs/data-model/fin.md`, `docs/data-model/platform.md`, `docs/MODULE_BOUNDARIES.md` (FIN and INV cards), the `hakorem-ledger` skill, every session that adds a ◆ event.

## Verification

- `test/integration/fin/journal-rules.integration.spec.ts`: every journal rule refused by raw SQL as hk_app with its named error; six scratch mutations each turned their test red (B8 report).
- `test/integration/fin/posting-matrix.integration.spec.ts`: every row of ADR-0003 whose event is published today posts exact amounts and subledgers; a reversal swaps the original's lines; a replay collides; a refused posting rolls the stock movement back; the boot assertion names a missing handler and a missing rule, and stops the application.
- `test/integration/fin/trial-balance.integration.spec.ts`: the seeded trading day sums to zero and reconciles with the cost pools; a tampered entry is reported and left.
- `test/integration/platform/number-series.integration.spec.ts`: 120 concurrent allocations with a third rolled back, and 30 serializable commands, leave contiguous series; red when allocation is made non-transactional.
