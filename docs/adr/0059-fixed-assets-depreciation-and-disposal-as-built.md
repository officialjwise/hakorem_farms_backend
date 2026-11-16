# ADR-0059: Fixed assets, depreciation runs and disposal as built

- **Status:** Proposed
- **Date:** 2026-11-16
- **Session:** B08 continued 1c2
- **Deciders:** backend track; the accountant reviews the depreciation and disposal conventions (A-199)

## Context

ADR-0003 seeds the fixed asset accounts (1510 to 1540 at cost, 1590 accumulated depreciation, 6500 depreciation) and one matrix row, `fin.DepreciationRun` (Dr 6500, Cr 1590). FR-FIN-014 asks for a register whose disposal "records proceeds and posts the gain or loss"; FR-FIN-015 for straight-line runs spread with `allocate`, posted once per period, maker and checker apart. Neither says how an asset's cost reaches 1510 to 1540, whether disposal is an event of its own, where a gain or a loss posts, how a run of a farm with two branches posts when every line of an entry carries the entry's branch (ADR-0058), or what happens to a month no run charged.

## Options considered

1. **The register posts its own cost (Dr 15xx) when an asset is created, and disposal is a manual journal.** One place for the asset, but the cost would post twice when the asset was bought on a supplier invoice, and a hand-typed disposal can be wrong by a pesewa.
2. **The register only records; cost, depreciation and disposal all go by manual journal.** Safe from double posting, but depreciation by hand is what FR-FIN-015 exists to avoid.
3. **The register records and never posts its cost; depreciation and disposal are FIN's own ◆ events, posted through the balanced-entry path from rules held as data; the nightly reconciliation compares the register with 1510 to 1540 and 1590.**

## Decision

Option 3.

- **Cost.** Registering an asset posts nothing. Its cost reaches 1510 to 1540 the way the money left: a supplier invoice whose expense category is mapped to the asset account (a determination change, data only), a manual journal, or the opening balance journal for assets the farm already had. The register then holds the same figure, and the nightly `ledger-reconcile` job compares them through two subledger sources FIN registers for itself (ADR-0056's pattern): `fin.fixed-asset-cost` (the cost of every asset not disposed of, per category, against the determination `ASSET_CATEGORY`/`ASSET`: 1510 to 1540) and `fin.fixed-asset-depreciation` (their accumulated depreciation, as a credit, against `ASSET_CATEGORY`/`ACCUMULATED_DEPRECIATION`: 1590). A register and a ledger apart is a reconciliation break, reported and never corrected.
- **Depreciation.** `createDepreciationRun` (the maker) computes, for one accounting period that has ended, each asset's charge with `allocate` (FR-FIN-015): what is left to depreciate split equally over the months of the life not yet charged, the leftover pesewas in the earliest of them, so 1,000,001 over three months is 333,334, 333,334 and 333,333 and a run month by month sums to cost less residual exactly. A run charges every month in service up to its period that no posted run charged, so a month missed is caught up, never lost. `postDepreciationRun` (the checker, never the maker: the domain refuses it and the database holds `posted_by <> created_by`) publishes `fin.DepreciationRun` once per branch with assets on the run, and the ledger posts each as that branch's entry, Dr 6500 and Cr 1590 per asset with the asset as cost object, dated the period's last day and never moved: a locked or closed period refuses it (`PERIOD_NOT_OPEN`). The database holds one run per period (`uq_depreciation_run_period`), one entry per run and branch, the lines' total equal to the run's and to the entries' 6500 debits, and each line applied to its asset only from the month it was computed from, so a run that went stale (an asset changed or charged by another run since) cannot post.
- **Disposal.** `disposeFixedAsset` publishes FIN's own ◆ event `fin.FixedAssetDisposed`, a new row of ADR-0003's matrix: Dr 1590 accumulated depreciation, Dr the proceeds account (the farm's own account of the kind the proceeds came in by, through `PAYMENT_METHOD_KIND`/`PAYOUT`: a named bank account or wallet against its own party, or cash to the safe), Dr or Cr the new account 4920 "Gain or loss on disposal of fixed assets" (income, normal credit, cash flow category investing), Cr 15xx at cost. The disposal is a business document (`FIXED_ASSET_DISPOSAL`) and posts on its own date or not at all.
- **Rules as data.** Both events, their rules and the eight determinations are seeded by migration, changeable by `POSTING_RULE_CHANGE` like every other.

## Consequences

- Nothing posts an asset's cost twice, and a register that disagrees with the ledger is found the next night.
- The register cannot be loaded with depreciation charged before the books opened: an asset the farm already had is registered at its carrying amount on the opening date, with its remaining life (A-199).
- A draft run whose period is locked before it posts never posts; the next period's run charges its months.
- The disposal's gain or loss sits in one income account, as 4210 holds both directions of a price variance.
- Binds: `docs/data-model/fin.md`, the `hakorem-ledger` skill, the FIN card in `docs/MODULE_BOUNDARIES.md`.

## Verification

- `src/modules/fin/domain/fixed-asset.spec.ts` and `asset-months.spec.ts` (the 100 percent gate on `src/modules/fin/domain/`).
- `test/integration/fin/fixed-assets.integration.spec.ts`: the register, every operation refusing the wrong role and the wrong branch, `fin.FixedAssetDisposed`'s exact lines (a loss into a bank account, a gain in cash), the database's refusals, the reconciliation sources clean and then reporting a tampered register; `test/integration/fin/depreciation-runs.integration.spec.ts`: `fin.DepreciationRun`'s exact lines, the exact spread, once per period under concurrent runs and the unique key, maker and checker in the application and the database, a locked period, a caught-up month, a stale run; `test/integration/fin/financial-statements.integration.spec.ts`: the statements still tie on the seeded trading day with the seeded assets and a posted run.
