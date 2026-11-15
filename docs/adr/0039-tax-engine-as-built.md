# ADR-0039: The tax engine as built: where ADR-0020 left a choice

- **Status:** Proposed (owner approves by merging the B04 continued pull request)
- **Date:** 2026-11-15
- **Session:** B04 continued
- **Deciders:** backend track; owner

## Context

ADR-0020 fixes the shape: named levies as data, a matrix of cells per category and levy in effective-dated versions, maker-checker activation, the exclusive and inclusive calculation, and "a version can be activated only if it contains a row for every category and every levy". Building it met seven questions ADR-0020 does not answer. Each is cheap to reverse: one function, one trigger or one line of the contract.

## Decisions

1. **Tax dates are business dates, half-open.** `valid_from` and `valid_to` are `date` columns in Africa/Accra. `valid_from` is the first day a version applies and `valid_to`, when set, the first day it no longer does, so two versions meet without a gap or an overlap (`EXCLUDE ... daterange(valid_from, valid_to, '[)')`). The calculator's caller passes the tax date; the version in force is the one whose window holds it.
2. **Activation starts no earlier than the day of approval**, as ADR-0036 decides for prices. A version approved after its `valid_from` starts on the day of approval; one whose whole window ended by then cannot be activated (`WINDOW_PASSED`). The trigger lets activation move `valid_from` later, never earlier. A late approval therefore never changes the scheme a document was already taxed under. Activation ends an earlier open version the day the new one starts and supersedes one that starts on or after it.
3. **One open version at a time.** At most one version is `DRAFT` or `PENDING_APPROVAL` (`uq_tax_scheme_version_open`). The matrix is one thing; two drafts of it would race to supersede each other. The accountant finishes or abandons a draft before starting another.
4. **The matrix is checked three times.** The domain (`defineTaxMatrix`) refuses an incomplete or invalid matrix when cells are replaced; submission checks again against the categories and levies live at that moment (a levy added after the cells were written leaves a gap); and a deferred constraint trigger refuses any version leaving `DRAFT` without a cell for every live category and levy. Cells and their base components are frozen by trigger once the version leaves `DRAFT`, and two cells of one category may not share a calculation order (the tie-break of the inclusive split must be deterministic).
5. **Every `mdm.tax.manage` operation needs step-up.** ADR-0020 says changing tax configuration is a step-up action, and step-up is a property of the permission (`iam.permission.requires_step_up`), not of the operation. The planned contract marked only three of the five `mdm.tax.manage` operations; `createTaxSchemeVersion` and `replaceTaxSchemeCells` now carry `x-requires-step-up` too (contract 1.5.0). The checker holds `mdm.tax.approve`, also step-up, seeded to the Owner only; the Accountant drafts and submits.
6. **Registration is read as at the start of the tax date.** `tax.registered` (`platform.setting`, boolean, effective-dated) is read for midnight at the start of the tax date; Africa/Accra keeps UTC all year, so that is midnight UTC. An absent setting means registered. While not registered every levy row is produced at zero, the inclusive gross is wholly net, and the response prints the rate actually applied, `0.00`.
7. **The version list carries no cells.** A matrix is at least 21 cells; `listTaxSchemeVersions` returns each version with an empty `cells` array, and `getTaxSchemeVersion` returns the full matrix. The planned description ("omits cells except on the first version") did not say which version was first; it now says what the list returns.

Also recorded:

- **No scheme is seeded by a migration.** Rates are business data that the accountant enters and the owner approves. The seeded farm creates its scheme through `TaxAdmin` (A-085); until a version is active, `calculateTax` answers 422 `TAX_SCHEME_NOT_IN_FORCE` rather than taxing at zero.
- **Two new error codes**: `TAX_CELL_INVALID` (a cell breaks a rule: a rate on a non-standard treatment, a base that does not fit its kind, a circular or foreign base levy, a repeated calculation order) and `TAX_SCHEME_NOT_IN_FORCE`.
- **The inclusive split never fails in practice**, because the net always carries a positive weight; the calculator still returns the kernel's `Result` from `allocate` rather than assuming it, and the service treats a refusal as a broken invariant.

## Consequences

- A tax change dated in the past takes effect from the day it is approved; a correction to tax already charged is a credit or debit note (B8), not a backdated scheme.
- The accountant cannot prepare next year's scheme while this month's correction is still a draft.
- Every tax write asks for a TOTP code within five minutes.
- Reversal: decisions 1 to 4 live in migration 0014 and `domain/tax/tax-scheme.ts`, changed by a new migration; 5 is the permission row and two contract flags; 6 and 7 are one function each.

## Verification

- `src/modules/mdm/domain/tax/tax-calculator.spec.ts` and `tax-scheme.spec.ts`: exact pesewas for exclusive, inclusive (the GHS 459.00 beef pack into 382.50, 57.38, 9.56 and 9.56), compounding, zero-rated, exempt, not registered, and the rounding edges; 100 percent on all four measures, gated in `vitest.config.mts`.
- `test/integration/mdm/tax-schema.integration.spec.ts`: every rule of migration 0014 violated once.
- `test/integration/mdm/tax.integration.spec.ts`: the lifecycle through the API, maker refused as checker, the wrong roles refused, a late approval starting on the day of approval, a later compounding version ending the first, a levy added after drafting refused at submission.
