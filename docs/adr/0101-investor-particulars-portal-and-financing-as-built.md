# ADR-0101: The rest of CAP as built: sealed particulars, the portal by session, loans and grants on the ledger

- **Status:** Proposed (the owner and the accountant review A-384 and A-385)
- **Date:** 2026-11-24
- **Session:** B12 continued
- **Deciders:** backend track; the owner and the accountant review A-384 and A-385

## Context

B12 built the investor register, capital and distribution runs (ADR-0100) and left FR-CAP-002 (payout details and
documents), FR-CAP-013 (the statement), FR-CAP-014 (return metrics), FR-CAP-015 (loans and grants) and the investor
portal (FR-IAM-013) to B12 continued, refusing their contract fields with `FIELD_NOT_YET_SUPPORTED`. The SRS and the
contract leave open: who approves the first payout details, how the portal finds an investor, which subledger party a
lender who is not an investor uses for 2400 (ADR-0003 names 2400's subledger INVESTOR), how and when interest is
accrued, how a grant's deferred income is recognised (ADR-0003 has `cap.GrantReceived` but no recognition row), and how
a repayment that names its own split is held to "interest first".

## Options considered

1. **The first payout details set at once, only a change approved** (PUR's supplier rule). Rejected for investors: the
   first details are where the first distribution goes, and one person entering them alone is abuse case 68's path.
   **Every setting approved by a different person** (`INVESTOR_PAYOUT_CHANGE`). Chosen.
2. **The portal reading by an investor id in the request**, checked against the session. Rejected: an identifier would
   be a key (owner's decision 5, 2026-11-17). **The investor found by the session's principal** (`cap.investor.principal_id`,
   unique); no portal request names an investor. Chosen.
3. **A lender who is not an investor registered as an investor.** Rejected: it would give a bank units, a portal and a
   share of profit. **The financing itself as the INVESTOR party of 2400** when the lender is not a registered investor;
   the investor when they are. Chosen.
4. **Interest accrued on demand when read.** Rejected: a read would write the ledger. **A daily job that accrues each
   finished calendar month on its last day, once (`uq_financing_accrual_month`), and the same accrual run first inside a
   repayment's transaction**, so the split always sees every finished month. Chosen.
5. **A grant recognised all at once.** Rejected: FR-CAP-015 says over its period. **A new event `cap.GrantRecognised`
   (Dr 2450, Cr 4910), one equal part a finished month by `allocate`, over a required term.** Chosen; ADR-0003's matrix
   gains this row by this ADR (it does not change an existing row).

## Decision

- **Sealed particulars (FR-CAP-002, ADR-0022):** the identity number and payout details are sealed with the investor's
  own subject key, each ciphertext bound to its place (the change's id, the investor's id), and shown only masked
  (`GCB, ****1180`, `****89-3`). Every setting of payout details waits for someone other than its maker holding
  `cap.investor.payout.approve` (Owner), with step-up; one waits at a time. The full details are revealed only to
  `cap.investor.payout.read` (Owner) with step-up, each reveal audited `DECRYPT`. `cap.InvestorPayoutChangeRequested`
  and `cap.InvestorPayoutChanged` are published for the daily exception report.
- **Documents:** a clean `INVESTOR_DOCUMENT` or `AGREEMENT` upload is kept for one investor; the portal lists only that
  investor's and signs a five-minute link to one of them, each issue logged; another investor's is 404.
- **The portal:** six reads in the INVESTOR realm, the investor found by the session's principal; a login opened by
  `createPortalLogin` (IAM's `AccessAdmin.createInvestorLoginIn`, additive) holds no role and a random password nobody
  sees; the investor sets theirs through the password reset (A-385). Its subdomain and cookie stay B13's.
- **Statement and returns (FR-CAP-013, FR-CAP-014):** computed on request from CAP's rows, never stored; the statement
  shows capital at value dates and distributions on the day posted and paid, so it ties to the investor's 3000 and 2300
  subledgers; ROI, payback and IRR in integers and thirty-place fixed point (never a float), the IRR's closing value the
  investor's share by units of the farm's equity in FIN's balance sheet (`FinancialStatements.equityIn`, additive).
- **Loans and grants (FR-CAP-015):** recorded as a numbered DRAFT with its schedule (principal in equal parts by
  `allocate`, interest projected), drawn and posted on its start date only when someone other than its maker holding
  `cap.financing.approve` approves (`FINANCING`); a loan's simple interest, actual/365, on the principal outstanding each
  day, half-up once a month, posted on the month's last day; a repayment's split is refused unless it pays accrued
  interest first (`INTEREST_FIRST`), never above what has accrued or is outstanding (the database too, HK010), and never
  dated into a month already accrued. `FLAT` interest is refused (`INTEREST_BASIS_NOT_SUPPORTED`): the SRS names simple
  actual/365 only. What was paid against an instalment and what is outstanding are derived from the repayments, never
  stored (the data model's `outstanding_pesewas` and `paid_pesewas` columns are not built).

## Consequences

- Nobody alone can change where an investor's money goes, and nobody sees full payout details without a second factor
  and an audit row.
- An investor can only ever read their own record: there is no parameter to change.
- A month whose period was locked before it was accrued blocks repayments of that loan (`INTEREST_NOT_ACCRUED`) and is
  logged by the job; the accountant reopens the period or posts the interest by manual journal.
- Binds: migrations 0358 to 0361, `docs/data-model/cap.md`, the CAP card, docs/API.md (Capital), A-384, A-385.

## Verification

- `src/modules/cap/domain/returns/returns.spec.ts`, `src/modules/cap/domain/financing/financing.spec.ts` (100 percent),
  `src/modules/cap/domain/investor/payout.spec.ts`.
- `test/integration/cap/investor-books.integration.spec.ts` (FR-CAP-002, the portal's isolation, FR-CAP-014, FR-CAP-015's
  acceptance: 1,019 accrued, 5,000 to 1,019 interest and 3,981 principal) and `test/integration/cap/uat-scenario-4.integration.spec.ts`
  (steps 4.10 and 4.11 through the portal).
