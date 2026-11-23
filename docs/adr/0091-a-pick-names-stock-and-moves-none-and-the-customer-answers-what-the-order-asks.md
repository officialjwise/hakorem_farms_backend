# ADR-0091: A pick names stock and moves none; the customer answers what the order asks, never the person who asked

- **Status:** Proposed
- **Date:** 2026-11-23
- **Session:** B11 (lane B)
- **Deciders:** backend track; the owner reviews A-332 to A-334

## Context

FR-ORD-008 to FR-ORD-013 and ADR-0021 need pick lists, picks weighed pack by pack, re-pricing at the weighed quantity,
the customer's consent beyond the tolerance, a substitute or (CR-054) a smaller quantity only with the customer's
agreement, and packing; dispatch then issues the invoice on the weighed quantity and moves the goods (FR-ORD-011,
B11 continued). Two questions had no written answer: when stock moves, and who may record the customer's answer.

A confirmed order already holds its stock (FR-ORD-005, ADR-0019): reservations in the base unit, oldest first, at
whatever location had it. A picker may take a different lot, or the same lot at a pick location the reservation did not
name, and swap a pack for one that fits the tolerance. A movement at every pick and swap would write and reverse stock
movements and journals for goods that never left the farm.

The customer's consent decides what the farm may charge and send. A storekeeper who could record a consent they had
asked for could raise a weighed total, or send something else, with nobody else seeing it.

## Options considered

1. **Move stock at pick** to a packing location, reversing on every withdrawn pick. Exact on-hand by location while
   picking; many movements and journals that net to nothing; a cancelled pick list moves stock back.
2. **Move nothing at pick; check every pick against what the location holds for this order**, move the goods once, at
   dispatch, from where they were picked.
3. **Re-point the order's reservations at every pick** (release and reserve). Exact promise; a release and a reserve
   per scan, and serializable contention on every balance a picker touches.

For the answer: (a) anyone with the permission; (b) never the person who asked, unless the customer answers
themselves or through a signed link; (c) only the customer.

## Decision

Option 2, and answer (b).

- A pick is a row of `ord.fulfilment_line`: its client id the key, its quantity in the line's unit and in the base unit
  (a catch-weight pack takes its weighed kilograms), its weight with its source. It moves no stock. Each pick is checked,
  in the same serializable transaction, against what the pick location holds that nobody else is promised: INV's
  promisable balance there plus the order's own reservations there. A balance below zero (ADR-0081) offers nothing, so a
  pick never takes a location below zero and never takes stock promised to another order. Dispatch (B11 continued)
  consumes the order's reservations and issues the picked stock from the pick location in one transaction.
- A withdrawn pick is kept, marked and never counted again; a cancelled pick list keeps its picks. Nothing is removed.
- The order line carries its picked figures while it is picked (`qty_fulfilled`, `fulfilled_weight_kg`, `weight_source`
  as its least trusted pack, `final_line_total_pesewas` as `half_up(price x weighed kg)` once over the line); dispatch
  fixes them with the invoice.
- What an order asks its customer is a row of `ord.order_consent` (a higher total, a substitute, a smaller quantity),
  one waiting per order, answered once. Staff record an answer taken by phone, in person or on WhatsApp only when they
  are not the person who asked (`ck_order_consent_answered`, and FULFILMENT_INVALID `CONSENT_ASKER_CANNOT_ANSWER` above
  it); the customer answers in their account (`CUSTOMER_ACCOUNT`); an answer through a signed link names `SIGNED_LINK`.
  Every question and answer is published (`ord.CustomerConsentRequested`, `ord.CustomerConsentAnswered`) for NTF's
  message and for the daily exception report (abuse case 42).

## Consequences

- No movement or journal is written for a pick, a swap or a cancelled pick list; on-hand by location stays the
  ledger's until dispatch. A picked pack the order does not hold can, in principle, be promised to another buyer until
  dispatch; dispatch then refuses rather than take the location below zero.
- Dispatch must consume the order's reservations and issue from the pick location (B11 continued's opener says so).
- A consent needs two people when staff take it, or the customer's own answer.
- Binds: `docs/data-model/ord.md`, the ORD card in `docs/MODULE_BOUNDARIES.md`, `docs/API.md` (ORD), abuse case 42.

## Verification

`test/integration/ord/fulfilment.integration.spec.ts`: a 20.000 kg pack refused when the cold room's stock is promised
to others; the picks of a cancelled order or pick list withdrawn and no movement written; the person who asked refused as
the recorder, in the application and by the database; the customer's own answer recorded as `CUSTOMER_ACCOUNT`.
