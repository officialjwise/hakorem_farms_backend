# ADR-0100: Investor capital and distributions as built: kept at head office, units never rounded, a submitted run never edited

- **Status:** Proposed (the owner and the accountant review A-380 to A-382)
- **Date:** 2026-11-24
- **Session:** B12
- **Deciders:** backend track; the owner and the accountant review A-380 to A-382

## Context

ADR-0028 fixed how a distribution is allocated: unit-days, the contribution day counted and the withdrawal day not,
largest remainder on integer pesewas, ties to the lower investor number, draft to paid with a different approver who
steps up. It left to the build where the investor books sit in the branch model, how units are derived from money, how
a value date before the books begin posts, what "editing a submitted run voids the approval" means, and who holds
which CAP permission. FR-CAP-002 (payout details) to FR-CAP-015 (loans and grants) are larger than one phase could carry
with CST, RPT and API, so B12 builds CAP to the distribution gate and B12 continued the rest (A-383).

## Options considered

1. **Investor books per branch**, scoped like a sale. Rejected: capital and profit belong to the one legal entity; a
   branch has no investors of its own.
2. **Investor books farm-wide for any holder of a CAP permission, wherever granted.** Rejected: an Owner granted only
   at a satellite branch would read every investor's position.
3. **Investor books at the head office branch** (MDM's first live branch, where a farm-wide record that belongs to no
   branch is already held and approved, A-166). Chosen.
4. **A submitted run recomputed in place, its approval withdrawn and re-requested.** Rejected: DOC archives one
   revision of a distribution schedule (`ck_archived_document_revision`), and an approver could be shown one schedule
   and approve another computation in a race. **A submitted run never edited** (rejected or withdrawn, then drafted
   again). Chosen.

## Decision

- **Where:** every CAP permission is checked at the head office branch, deny by default (A-381). Investor data is read
  by the Owner and the Accountant only; the Manager holds none of it. The Owner also holds the maker's permissions (IAM
  lets a granter grant only what they hold) and is the only checker; the maker never checks (IAM, the application and
  `ck_capital_withdrawal_request_checker`, `ck_distribution_run_checker`).
- **Step-up:** changing the register, recording capital, posting a run and recording a payment to an investor need a
  fresh step-up, as do both approvals (A-381 (c)).
- **Units:** the amount over the unit price, exactly, to four places; never rounded, refused otherwise
  (`ck_capital_transaction_units`). The unit price is GHS 100.00 unless given (A-380 (b)).
- **Contributions and withdrawals:** a contribution posts at once (201); a withdrawal always waits for
  `CAPITAL_WITHDRAWAL` (202) and is written, numbered and posted only on approval. It never redeems more units than are
  held on its value date or any later day, checked when asked, at approval, and by `cap.capital_transaction_check`
  (HK010 `ck_capital_transaction_holding`) with the investor's row locked.
- **Posting date:** the value date. A value date in a period that is not open is refused; one before the ledger's first
  period posts on that period's first day, its units still counting from the value date (A-380 (d)).
- **Runs:** drafted over periods that have ended, are covered by accounting periods and are every one locked or closed;
  net profit is FIN's profit and loss figure for the range (`FinancialStatements.netProfitIn`); a draft may be
  recomputed (each computation kept, `computation_no`); a submitted run is never edited (A-382); the schedule is
  rendered and archived after commit at submission, its archive linked by `doc.DocumentArchived`; posting publishes
  `cap.DistributionDeclared` once (Dr 3300 each allocation and Cr 2300 each net payable against the investor, Cr 2310
  withheld); payments publish `cap.DistributionPaid` (Dr 2300, Cr 1100 or 1110 by the account's kind). Profit is
  distributed once: periods of runs not rejected never overlap (`ex_distribution_run_period`).
- **Not built here** (B12 continued): payout details and the identity number, documents, the statement, return
  metrics, loans and grants, the investor portal. The contract's fields for them are refused with
  `FIELD_NOT_YET_SUPPORTED` until then, never silently dropped.

## Consequences

- An investor's share is repeatable with a calendar and a calculator (UAT scenario 4 matches to the pesewa) and the
  ledger ties to it exactly.
- A satellite branch's Owner sees nothing of the investors; an owner who must read them holds a head-office grant.
- A run that must change costs a rejection and a new draft, never an approval of something other than what was shown.
- Binds: `docs/data-model/cap.md`, migrations 0352 to 0357, the CAP card in `docs/MODULE_BOUNDARIES.md`, docs/API.md
  (Capital), A-380 to A-383.

## Verification

- `src/modules/cap/domain/distribution/distribution.spec.ts` (ADR-0028 Tests 1 to 4 under their names, 100 percent).
- `test/integration/cap/capital-and-distribution.integration.spec.ts` (Test 5, withdrawals, wrong roles, the database's
  rules) and `test/integration/cap/uat-scenario-4.integration.spec.ts` (UAT scenario 4 at the desk).
