# ADR-0076: A receipt's claim is settled once, by the invoice that left the rejected goods out or by a credit note against the invoice that charged them

- **Status:** Proposed (B09e continued 3, 2026-11-17; the most conservative workable answer to A-271, built and waiting for the owner). It changes the three-way match (FR-PUR-009) for one new case and nothing else; no posting rule, account or FIN code changes, and every journal the ledger posted before posts the same.
- **Date:** 2026-11-17
- **Session:** B09e continued 3
- **Deciders:** backend track; the owner to accept

## Context

The owner's decision 5 (2026-11-17, CR-036): a claim raised from a posted goods receipt's rejected lines drafts the supplier credit note from the rejected lines and their cost, never keyed by hand, moving no stock and posting nothing until the credit note is approved, on the supplier's account until it is settled.

A-271 found the trap before any code was written:

- **The match.** An invoice line matches only up to the quantity received, which is the accepted quantity: `QTY_EXCEEDS_RECEIVED`, which an approved variance cannot cover (FR-PUR-009, FR-PUR-010).
- **The credit note.** A credit note must reduce an approved invoice (FR-PUR-011). With no goods sent back it posts the payable down against purchase price variance (5140).

So a supplier who invoices only the 23 good eggs of a crate has already left the 7 cracked ones out. A credit note drafted from the claim against that invoice would credit the 7 eggs a second time, and the supplier would be underpaid. A supplier who invoices all 30 eggs cannot be matched at all, so there is no approved invoice for the credit note to reduce.

Suppliers do both. The claim must work in both cases, and must never credit the same eggs twice.

## Options considered

1. **The credit note is the claim, raised against whatever invoice exists.** The claim drafts a credit note straight away against an approved invoice of the order. Its cost: it credits twice when the invoice charged only the accepted eggs, and it cannot exist before the invoice does, which is usually after the receipt.
2. **The receipt is valued at the delivery and the claim reduces it.** The receipt books the whole delivery to 2010, and the claim moves the rejected part back out. Its cost: stock that never entered would be valued on the receipt, and the receipt's posting would change. Refused: that changes an existing posting.
3. **Settled once, by whichever document the supplier sends (chosen).** The claim stays open until one of two documents settles it, and the match allows exactly the open claim's rejected quantity on top of what was received. Each settlement is checked against what the supplier actually invoiced:
   - an invoice that left the rejected goods out settles the claim on its own;
   - an invoice that charged them is reduced by a credit note drafted from the claim.
   Its cost: one change to the three-way match, and two operations to choose the settlement.

## Decision

Option 3.

- **The claim.** `pur.supplier_claim` and `pur.supplier_claim_line` (migration 0223) hold one claim per posted purchase receipt with rejected lines, raised by `raiseSupplierClaim`.
  - Each line names its receipt line, order line, product and reason, from the receipt's `rejectionReasonCode` (A-269).
  - Each line holds the delivered, accepted and rejected base quantities, from INV's `qty_received` and `qty_rejected` (A-263).
  - Each line holds three values:
    - `line_value_pesewas`: the delivered quantity at the order line's price, rounded half-up once. The quantity is converted by the order line's own stored conversion, `qty_ordered / qty_ordered_base` (ADR-0001).
    - `accepted_value_pesewas` and `claimed_value_pesewas`: the kernel's `allocate` over the accepted and rejected base quantities. The database holds that they sum to the line value exactly.
  - The rounding rule:
    - With the two keys `ACCEPTED` and `REJECTED`, `allocate` gives the accepted share exactly `half_up(line x accepted / delivered)`, and the claim the rest.
    - That is ADR-0075's half-up. Floor plus the largest remainder, with ties to `ACCEPTED`, is half-up for two parts.
    - Half-to-even is never used.
  - No request carries an amount: the operation takes an optional note and nothing else.
  - Raising a claim moves no stock and posts nothing. It publishes `pur.SupplierClaimRaised`, which is not a ledger event.
- **The match allows exactly the open claims.**
  - **The rule:** an invoice line on an order line matches when its quantity is at most what was received, plus the rejected quantity of that order line's claims not settled by an invoice, less what other live invoices hold.
  - **The quantity variance** is still reported against what was received.
  - **Everything else is unchanged:** price, levy, product and order line checks.
  - **When it applies:** only when a claim exists. Without one, the match is what FR-PUR-009 says.
- **What the supplier did not deliver never reaches 2010.**
  - An approved invoice line that carries a claimed quantity publishes its `orderValuePesewas` for the received part only: `half_up(order price x qty x received / qty_base)`.
  - That is what the receipt booked to 2010, as the field is documented.
  - The rejected part therefore lands on 5140, by FIN's existing rule, until the credit note takes it off 5140 again, by FIN's existing credit note rule.
  - A line that carries no claimed quantity publishes exactly what it did before.
  - FIN, its rules and the event's shape are untouched.
- **Settled by the invoice** (`settleSupplierClaim`).
  - **What it needs:**
    - an approved or paid invoice of the claim's order, with a line on every order line the claim names;
    - and, on each of those order lines, the live invoices hold no more than was received plus the claims already settled by a credit note.
  - **What that means:** the supplier did not charge the rejected goods.
  - **What it refuses:** an invoice that charged them is refused with `CLAIM_INVOICED`.
- **Settled by a credit note** (`draftSupplierClaimCreditNote`, then the existing `submitSupplierCreditNote` and approval).
  - **What it needs:**
    - the named invoice is approved, of the claim's order, with a line on every order line the claim names;
    - and, on each of those order lines, the live invoices hold at least what was received, plus the claims credited already, plus this claim.
  - **What that means:** the supplier charged the rejected goods.
  - **What it refuses:** otherwise `CLAIM_NOT_INVOICED`.
  - **The credit note's lines:** one per claim line, in the product's base unit.
    - The quantity is the rejected base quantity.
    - The net is exactly the claim line's claimed value. A composite foreign key to the claim line holds the net and the quantity.
    - A claim line has no unit price of its own, so its stored price is 0. The usual `round(qty x price)` check is lifted for claim lines only.
    - The levies come from MDM's calculator, as on any invoice line.
  - **One live credit note per claim:** a claim has at most one credit note that is not cancelled.
  - **Settlement:** the claim is settled when its credit note is approved, in the approval's transaction.
- **Maker and checker.**
  - The credit note keeps its `SUPPLIER_CREDIT_NOTE` approval. Its approver must not have entered or submitted it.
  - Now also refused as its approver, with `INVOICE_MAKER_CANNOT_APPROVE`:
    - the person who raised the claim;
    - the person who posted the receipt that recorded the rejection.
- **Exactly once.**
  - **After an invoice settles a claim:** its quantity no longer widens the match, so a later invoice charging the rejected goods mismatches.
  - **After a credit note settles a claim:** its quantity still widens the match for the invoice it credited, and no further.

## Consequences

- **The supplier's balance comes out to the pesewa either way.**
  - **The invoice charged only the accepted crates:** the supplier is owed that invoice, and the claim is settled by it.
  - **The invoice charged everything:** the supplier is owed the invoice less the credit note, which is the accepted share.
- **The ledger's accounts net to zero.** In the second case the rejected value sits on 5140 between the invoice's approval and the credit note's. When the credit note is approved, 2010 and 5140 for the delivery both net to zero.
- **A claim that is never settled stays open.**
  - It shows in `listSupplierClaims` with status `OPEN`, the supplier's account until settled.
  - A claim written off, or settled by a replacement delivery, is not built (BL-076).
  - After a replacement delivery, the receipt raises the received quantity, so the invoice that charged the whole delivery settles the claim through `settleSupplierClaim`.
- **Binds:**
  - FR-PUR-009 (the match) and FR-PUR-011 (the credit note), and `docs/data-model/pur.md`;
  - the PUR card in `docs/MODULE_BOUNDARIES.md`;
  - abuse case 34 in `docs/security/THREAT_MODEL.md`;
  - A-272.

## Verification

- `test/integration/pur/receipt-claims.integration.spec.ts`, written first and seen red:
  - **One crate at 4,751 with 7 of 30 eggs rejected:** a line of 4,751, accepted 3,642, claimed 1,109. The invoice charges the crate and is matched only because of the claim. The credit note is 1,109. The supplier is owed 3,642, and 2010 and 5140 net to 0.
  - **Three crates at 4,751 with one crate rejected, entered in crates:** claimed 4,751. Charged all three, credited 4,751, owed 9,502. Charged two, the claim is settled by that invoice, owed 9,502. Both refusals are tested: `CLAIM_INVOICED` and `CLAIM_NOT_INVOICED`.
  - **An amount sent is refused.** The claim moves no stock and posts nothing.
  - **Maker and checker:** the maker, the receiver and the approver are three people. The claim's maker is refused as approver.
  - **The wrong role is refused,** and `pur.SupplierClaimRaised` carries abuse case 34.
- `src/modules/pur/domain/claim.spec.ts`: the split and its rounding at an exact half, below and above.
- The mutation checks are in the B09e continued 3 report.
