# ADR-0069: Price override approval as built

- **Status:** Proposed
- **Date:** 2026-11-17
- **Session:** B09a continued 2e
- **Deciders:** backend track; the owner confirms who approves an override and the per-line limits (A-230); the accountant reviews the proforma

## Context

FR-ORD-003: "An agreed price outside floor and ceiling, or beyond the user's limit, needs an approval by a different user; the database check requires the approval when the flag is set." Abuse case 3 (repeated small overrides at the counter) asks for limits per role, per line and per shift, a mandatory reason, and every variance on 4210. ADR-0017 makes amount limits role attributes read by the owning module and enforced in its domain code, and binds an approval to its subject by a payload hash. Until this phase every price below list was refused (A-208 (c), the owner's interim). Two paths price a sale: `createOrder` writes an order that waits for confirmation, and `SalePosting.postIn` posts a sale in one transaction, with its tenders, which no order row holds before the sale is posted.

## Options considered

1. **One approval on the order, applied by the handler, for both paths.** Right for `createOrder`. For the sale posting the handler would have to post the sale itself, which needs the tenders, locations and till, so a held-sale table this phase does not own (POS's held sales are B9b's).
2. **For the sale posting, a pre-approval bound to the exact sale.** The seller asks first (`requestOverrideIn`): the sale's client id is registered as its order's document, the approval is asked on it with the hash of every flagged line's pricing record, and nothing posts. Once approved, the same seller posts the same sale, which names the approval. Different prices, another seller or a pending approval post nothing.
3. **Approve after the fact.** The sale posts and the approval is asked afterwards. The farm loses the money before anyone checks; only offline sync may do this (OFFLINE_SYNC, B9b).

## Decision

Option 1 for `createOrder`, option 2 for the sale posting.

- **The judgement (ORD domain, `judgeOverride`).** Outside the band always waits; below list within the band waits when the line's whole variance is beyond the seller's per-line limit (`PRICE_OVERRIDE_PER_LINE`, the largest of the roles held at the branch through IAM's `Authoriser.limitIn`, 0 when none is set); above list up to the ceiling needs its reason only. The per-shift limit is B9b's.
- **The approval.** IAM's `PRICE_OVERRIDE` (threshold 0, `ord.price_override.approve`, step-up), subject the order, payload the flagged lines' pricing record. The approver is not the person who asked (IAM), the order's salesperson or its writer (`judgePriceApprover`). In the database, past `PLACED` and not cancelled, every flagged line names its request and its approver, who is neither the order's writer nor its salesperson (`ck_sales_order_settled_lines`). Once a line names its request, its pricing record is fixed (`ck_sales_order_line_priced`).
- **`createOrder`.** The order is written `PLACED` with its flagged lines and answers 202. Approved, the lines name their approver. Until then it can be neither confirmed nor given a proforma. A cancellation withdraws a waiting request.
- **The sale posting.** As option 2. The approval handler of a sale not yet written records the approval and changes nothing, since nothing exists yet to change. What it approves, the sale at these prices by this seller, takes effect only when that sale posts, and is refused for any other.
- **The proforma (A-201).** `issueProforma` issues through `Billing.issueIn` once per order (`proforma_document_id`), at the lines' agreed prices, only when every override is approved.

## Consequences

- Nothing is reserved, issued or paid at a price a second person has not approved, on either path.
- With no limit seeded, every price below list still waits: the owner's interim (A-208 (c)) holds as data until the owner sets limits.
- B9b's till exposes `requestOverrideIn` (a supervisor approves at the counter before the sale completes). B11's dispatch posts an order whose overrides were approved at entry.
- Binds: `docs/data-model/ord.md`, `docs/API.md` (ORD), the ORD and IAM cards in `docs/MODULE_BOUNDARIES.md`, abuse case 3 in `docs/security/THREAT_MODEL.md`, A-230.

## Verification

- `test/integration/ord/price-override.integration.spec.ts`:
  - an order at 950 against a list of 1,000 waits (202, 100 off the line) and cannot be confirmed;
  - outside the band always waits;
  - within a 100 limit it is taken, and at 102 it waits;
  - a limit at another branch counts for nothing;
  - the wrong roles, the other branch and the maker are refused;
  - approved by the Manager, the order confirms;
  - a rejection leaves it unconfirmable, and a cancellation withdraws the request;
  - the salesperson as approver is refused by ORD and by SQL, and the order's writer by SQL;
  - the pricing record is fixed by SQL;
  - the sale posting refuses before approval and while it waits;
  - posted after approval at 58,000 against 58,500, it carries Dr 4210 500;
  - another seller and other prices are refused;
  - a proforma of 2,000 posts no journal and is issued once, never while an override waits nor for a cancelled order.
- `src/modules/ord/domain/price-override.spec.ts` at 100 percent under the `ord/domain` gate.
- Mutation runs (B09a continued 2e report).
