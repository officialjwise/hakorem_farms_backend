# ADR-0102: Costing as built: allocation through inventory, projections by refresh over published views, margin over price

- **Status:** Proposed (the owner and the accountant review A-387 and A-388)
- **Date:** 2026-11-24
- **Session:** B12 continued 2
- **Deciders:** backend track; the owner and the accountant review A-387 and A-388

## Context

ADR-0018 gives inventory the cost of record and leaves CST to analyse it and to post labour and overhead through
inventory's interface. ADR-0023 asks for projections that are idempotent and can be rebuilt. FR-CST-001 to FR-CST-008
ask for cost by element, labour and overhead allocation with a second person, margins that tie to the ledger,
break-even, losses apart from cost of sales and a rebuild that gives the same figures. Three things were not decided:
where an allocation's credit goes (the existing `inv.CostCapitalised` credits 1300, the store of feed and medicine),
how projections are kept without CST reading another schema's tables, and how margin facts get the cost of what each
line sold.

## Options considered

1. **Allocation through `COST_CAPITALISE`.** Reuses a movement type, but its ledger rule credits 1300, which holds no
   labour; the rule would have to change by cost element, an existing rule changed.
2. **A new value-only movement type with its own posting event (chosen).** `OVERHEAD_CAPITALISE` publishes
   `inv.OverheadAbsorbed`, posted Dr inventory by the product's GL group, Cr a new cost account 5220 "Labour and
   overhead absorbed into stock" (credit-normal, as 5210 "Own production capitalised"). Nothing existing changes.
3. **Projections maintained row by row in TypeScript from event payloads.** Payloads do not carry every dimension (a
   billing line names no channel or salesperson; a sale issue names no billing line), and a rebuild would be a second
   code path.
4. **Projections written only by SQL refresh functions over published views (chosen).** Each projection is a
   deterministic `SECURITY DEFINER` function over `inv.pub_movement`, `inv.pub_negative_stock_cost`,
   `bil.pub_document_line`, `ord.pub_sale_order`, `ord.pub_sale_line`, `mdm.pub_product` and `mdm.pub_reason_code`,
   taking the keys to refresh or null for all. The asynchronous consumer calls them for the keys an event names; a
   rebuild calls them with null. The two paths are one set of statements, so a rebuild gives the same figures by
   construction, and the application roles only read the tables (PROJECTION class).

## Decision

Options 2 and 4.

- **Allocation (FR-CST-002).** A run names a period (ending no later than today), LABOUR or OVERHEAD, a basis and a
  scope: a pen, or a whole branch (`branchId`, added to the contract's create body). HEAD_DAYS weighs each livestock
  unit by the whole head it had on hand in scope at the end of each Africa/Accra day of the period (the feed spread's
  head rule); EQUAL weighs each unit present one. `allocate` splits the amount, keyed by tag then id. A growing animal's
  share is CAPITALISED; a breeding or laying animal's, or one no longer on hand, EXPENSED: it stays in the period's cost
  and posts nothing (ADR-0018). WEIGHT_GAIN is refused until weighings are projected (BL-128). The run is a DRAFT; a
  different person holding `cst.allocation.post` (the Owner or the Manager), with step-up, posts it: each capitalised
  share above nothing becomes one OVERHEAD_CAPITALISE movement from the branch's CONSUMPTION location to where the
  animal stands now, dated when it is posted, in one serializable transaction with the ledger. The database holds the
  rules: created as a draft and posted once, nothing else of it ever changing; the lines summing exactly to the total at
  commit (HK010); the poster never the creator (`ck_overhead_allocation_checker`); one posted run per branch, element,
  scope and period (`uq_overhead_allocation_posted`).
- **Cost by element (FR-CST-001).** A unit's accumulated cost is every movement that added cost to it: a receipt,
  opening balance or harvest is PURCHASE, a value-only movement carries its own element, a processing output is
  PROCESSING; a reversal takes its original's element back. Issues, transfers and returns add nothing. A pen is the
  units on hand in it now; a batch its flock's unit (LIV's `Batches.stockUnitsOfIn`, additive). A processing order is
  each consumed unit's value split by that unit's elements through `allocate`, plus the outputs' value less the inputs'
  under PROCESSING (PRC's deferred rule makes that exactly the direct cost).
- **Margin facts (FR-CST-003, FR-CST-004).** REVENUE rows are the billed lines the ledger posts to sales and their
  deductions: every product line, every charge or adjustment line (to 4030, under BY_PRODUCT with no product) and every
  line of a credit note (its whole net posts to 4200). Revenue is the line's net, net of levies; the price variance is
  BIL's own rule. COST rows are each valued sale issue (online or offline), customer return and reversal of either, and
  each cost of stock sold ahead of receipt and its true-up, with the dimensions of the order line the sale was of (a
  return through the issue it returns). Margin is over the selling price (the owner, 2026-11-23). The nightly
  `costing-drift` job compares the projection's net revenue and cost of sales with accounts 4000 to 4030 less 4200,
  4210 and 4220, and 5000 to 5030, closing entries left out (FIN's additive `tradedNetDebitsIn`), over everything up to
  yesterday; a difference publishes `cst.ProjectionDriftDetected` and corrects nothing.
- **Break-even (FR-CST-005, FR-CST-006).** By product line: the average net price and variable cost per unit each
  half-up once from the period's totals; break-even units the line's fixed cost over contribution per unit, rounded up;
  break-even revenue those units at the average price. Fixed costs are the period's operating expenses (expense
  accounts in the operating section), assigned to the lines by revenue through `allocate` (A-388). The contract's
  planned example worked break-even revenue as fixed cost over the contribution ratio; it is replaced by this rule's
  figures, and the per-unit figures are added (additive fields).
- **Losses (FR-CST-007).** Each mortality, cull, adjustment loss and count loss (and reversal) under the loss group its
  reason posts to, as the ledger's LOSS_GROUP determination does (MORTALITY 5100, WASTAGE 5120, otherwise SHRINKAGE
  5110), at the location it left, with who recorded it. Rates per pen and handler are null until head kept is
  projected (BL-129).
- **Boundaries.** CST imports platform, IAM, MDM, FIN, INV and LIV through their doors (LIV is layer 6, lower; the card
  now says so) and reads published views only. No port. No new cross-schema key beyond the published ones.

## Consequences

- An allocation moves cost out of the period and into stock visibly: the period's wages and overheads stay gross in
  6000 to 6940, and 5220 shows what was carried into stock. The accountant may prefer crediting the expense accounts
  themselves (A-387 (a)); that would be a new rule row, not a change to this one.
- A projection can lag the ledger by the outbox delay; `refreshedAt` and `asOf` say when. A drift is reported, never
  corrected; the runbook is a rebuild (`docs/runbooks/stock-balance-drift.md` gains the costing case).
- Every new posting row is additive: ADR-0003's matrix gains `inv.OverheadAbsorbed` (Dr GL_GROUP INVENTORY, Cr 5220).
- Binds: `docs/data-model/cst.md`, the CST card in `docs/MODULE_BOUNDARIES.md`, `docs/API.md` (Costing).

## Verification

- Unit (`src/modules/cst/domain/costing.spec.ts`, 100 percent gate): 30,001 over 10, 10 and 5 head-days is 12,001,
  12,000 and 6,000; 60,000 + 8,400 + 3,000 = 71,400; input 71,400 plus direct 5,000; 85,000 against 71,400 is 13,600
  and 16.00; 600,000 over 13,600 a head is 45 heads and 3,825,000; the percent's half, below and above; the maximum.
- Integration (`test/integration/cst/costing.integration.spec.ts`, `margins.integration.spec.ts`): the acceptance of
  FR-CST-001, -002 and -007 on the real engine; the margin projection on the seeded trading day equal to the ledger
  (revenue, cost of sales and 4210) by every dimension, kept by the consumer exactly as a rebuild gives it; one drift
  reported after a row is deleted and none after the rebuild; twelve cost objects identical after the projections are
  dropped and rebuilt; the database refusing unbalanced lines, a changed run and a run posted by its maker.
