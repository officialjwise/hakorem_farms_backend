# ADR-0026: Session schedule amendment: order core before POS, and B9 split in two

- **Status:** Accepted. The order core and the B9 split were approved by the owner on 2026-11-13 at B0; the three further assignments were confirmed by the owner, exactly as proposed, on 2026-11-13 after the B1 gate (A-040 resolved)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** owner; backend track proposed the three further assignments

## Context

The shared brief requires "a single order record across every channel". The schedule in the brief builds orders in B11, but point of sale (B9) creates sales and quotations (B10) convert an accepted quote into a sales order. Both need the order record before B11.

The owner approved moving the order core to the start of B9, on condition that B9 is planned as two sessions from the outset, because it would otherwise be too large for one.

Working through the module map exposed three more places where the schedule in the build prompt does not say where something is built. They are listed here so that the gate can settle them, rather than being discovered in the session that needs them.

## Options considered

1. **Leave the schedule as written and let point of sale keep its own sale record.** Then there are two records of a sale, and B10 still has no order to convert a quote into.
2. **Move the whole order module ahead of B9.** Pulls fulfilment and delivery forward as well, which need notifications and are correctly late.
3. **Build the order core where it is first needed, and leave fulfilment where it is.**

## Decision

Option 3.

**Accepted**

- **B9a: order core and payments.** The sales order record and its state machine, sale posting (one transaction across stock issue, billing document, payment and ledger), returns against an original sale, and the payments module.
- **B9b: point of sale, shifts and offline sync.** Built on the order core: a counter sale is an order that is placed and completed in one step.
- **B11** keeps the rest of the order module: pick lists, picking with weight capture, packing, dispatch, partial fulfilment, substitution and cancellation after confirmation, with delivery and notifications.

**Further assignments, confirmed by the owner on 2026-11-13 exactly as proposed**

1. **Online store (SHP).** No backend session in the build prompt names it, yet the slot 8 gate requires that checkout reserves stock and releases it on timeout. Public catalogue, cart and checkout reservation in B7; order placement and online payment in B9a, when orders and payments exist; abandoned-cart messaging in B11 with notifications.
2. **Audit and administration (AUD), second part.** The audit trail is built in B3. Retention jobs and data-subject request handling are built in B13 with the other compliance work.
3. **Daily exception report.** It draws on every module. Built in B12 with reporting.

**Amended backend schedule**

| Session | Modules | What proves it |
| --- | --- | --- |
| B0 | Architecture, domain model, data model, threat model, ADRs | Owner approves the architecture and data model |
| B1 | SRS, documents, skills, `CLAUDE.md`, hand-written contract | The contract covers every screen the frontend has planned |
| B2 | Foundation: workspace, kernel, configuration, migrations, test harness, CI | One-command setup on a clean machine, CI green |
| B3 | Platform, IAM, audit trail, outbox, ports, the Product slice | The slice passes all four test layers; the frontend logs in against the real API |
| B4 | Master data, pricing engine, promotions, tax configuration | A price resolves for every band, channel and tier; an unresolvable request becomes a quote |
| B5 | Inventory: movements, balances, reservations, holds, valuation, stock take | On-hand from movements matches a hand count; stock cannot go negative outside allowed types; a lot traces both ways |
| B6 | Livestock, processing | A processing order produces lots whose costs sum exactly to input cost plus direct processing cost |
| B7 | Procurement and suppliers; storefront catalogue, cart and checkout reservation | Three-way match blocks payment on disagreement; checkout reserves stock and releases it on timeout |
| B8 | General ledger, billing, document generation | Trial balance sums to zero on a seeded day; an unbalanced journal is rejected by the database; numbering is gap-free under concurrent load |
| **B9a** | **Order core, payments;** online order placement and payment | Every payment edge case in the brief passes; an order on any channel posts stock, document, payment and ledger in one transaction |
| **B9b** | **Point of sale, shifts, offline sync** | Shift close reconciles; 500 queued offline transactions sync exactly once |
| B10 | Quotations, wholesale, credit control | Quote revisions are versioned; conversion to invoice preserves every link; a credit limit blocks with an audited override |
| B11 | Order fulfilment, delivery, notifications; abandoned-cart messaging | A catch-weight order re-prices at pick; cash on delivery lands against the driver; the outbox guarantees the customer notification |
| B12 | Capital and investors, costing, reporting, public API; daily exception report | A distribution matches a hand calculation on unit-days and ties exactly to the ledger |
| B13 | Load test, security review, smoke suite, runbooks, data migration, deploy; retention and data-subject requests | Every non-functional target met and evidenced on the live server |

**Effect on the frontend track**

- Slot 10 now holds two backend sessions, B9a then B9b. The frontend's F9 is unchanged: it builds the POS surface against the contract mock.
- The slot 10 gate, POS runs eight hours offline and syncs exactly once, is proven after B9b.
- The contract written in B1 already covers orders, since the contract is written for every module before any is built.

**Session reports** use the ids `B09a` and `B09b`, with branches `b09a-order-core-payments` and `b09b-pos-shifts-offline`.

## Consequences

- There is one order record for every channel from the first sale, and one code path that posts a sale.
- B9a becomes the session that proves the central transaction of the system. It is deliberately not sharing a session with offline sync.
- Fourteen slots become fifteen backend sessions. No other session moves.
- The order module is built in two passes. The boundary between them is clean: B9a ends at an order that is completed immediately or left confirmed and awaiting fulfilment; B11 adds what happens between confirmation and delivery.
- `docs/BUILD_PROMPT.md` is amended in its B4 to B12 table to show B9a and B9b, with a pointer to this ADR, so that the session that opens B9 reads the amended plan. `docs/SHARED_BRIEF.md` is left exactly as issued, because the frontend repository holds its own copy.
- Binds: `docs/BUILD_PROMPT.md`, `docs/MODULE_BOUNDARIES.md`, every session report from B8 onward.

## Verification

- Owner decision on the three further assignments: confirmed as proposed on 2026-11-13 (A-040).
- B8's session report names B9a as the next session, with its opening message.
