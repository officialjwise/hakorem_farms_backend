# ADR-0048: A transfer shortfall is received freely, held, and written off only with approval

- **Status:** Accepted (decided by the owner, 2026-11-15, answering A-139)
- **Date:** 2026-11-15
- **Session:** owner decision recorded between B05 continued 3 and B05 continued 3b
- **Deciders:** owner

## Context

FR-INV-011 asks for approval of a large variance found when a transfer is received. B05 continued 2 built receipt without that approval: a shortfall was posted at once as a loss with a `TRANSFER_VARIANCE` exception. Approval at receipt would have needed a 202 response on `receiveStockTransfer`, a contract change, so the question went to the owner (A-139).

Two observations from the owner decide it. First, approval at receipt blocks the wrong thing: a vehicle arriving at six in the morning could not be unloaded into sellable stock until a manager woke up. Second, the control does not belong at receipt anyway: the variance is detected whatever the receiver books, so approving the receipt adds nothing. What needs a second person is accepting the loss, not accepting the goods.

## Options considered

1. **Approve at receipt** (FR-INV-011 read literally). A 202 on `receiveStockTransfer`; the whole receipt, including the goods that did arrive, waits for a manager. Rejected for the reasons above.
2. **Post the shortfall as a loss at receipt** (as built in B05 continued 2). No approval anywhere, so a receiver and a driver together can turn missing stock into an expense with nobody else involved. Rejected: it is abuse case 7 ("stock adjustment used to hide a shortage") through another door.
3. **Receive freely, hold the shortfall, approve the write-off.** Chosen.

## Decision

- **Receipt is never blocked.** `receiveStockTransfer` keeps its shape and its 200: what arrived becomes the destination's stock at once.
- **A shortfall is held, not lost.** The missing quantity and its value at cost leave the in-transit location into a held state that is neither sellable stock nor an expense, and the `TRANSFER_VARIANCE` exception opens against it. When the ledger exists (B8), the held value posts to a holding (suspense) account, not to a loss or shrinkage expense.
- **Clearing the variance is a separate, later decision**, through `resolveStockException` (planned in the contract, not yet implemented, so implementing it is additive). It either:
  - **writes the shortfall off**, under exactly the rule for stock adjustments (A-139 point 1, confirmed): above 50,000 pesewas it needs approval with step-up by someone other than the maker, answering 202 `ApprovalPending` until approved; at or below, it posts directly. The write-off is the loss movement and, from B8, the expense posting; or
  - **records the goods as found**, returning the held quantity to stock at the location where it was found, with no expense.
- **The threshold is copied onto the document when it is made**, as adjustments already do, and is never read live from the policy afterwards. A later change to the approval policy therefore cannot silently rewrite the history of an approval: the record shows the rule that was in force when the decision was taken. This is also why ADR-0047 stays narrow: no stock trigger needs to read `iam.approval_policy`.

The phase that builds it chooses how the held state is represented (for example a held quantity on the transfer line kept in the in-transit location, or a dedicated virtual location with its own movement types), proved by tests: held stock is never available to sell, reserve or transfer; the on-hand hand count still reconciles; a write-off above the threshold cannot post without a different approver; a found variance cannot also be written off. Prefer a representation that adds no new value to an enumeration the contract returns; if one is unavoidable, it is a loud entry in `docs/CONTRACT_CHANGELOG.md`.

## Consequences

- `receiveStockTransfer` keeps its shape; its described behaviour changes (the shortfall is held, not posted as a loss), which the contract changelog states.
- `resolveStockException` gains a 202 response for a write-off awaiting approval, as part of its first implementation.
- B8's posting rules need a holding account for held transfer variances, cleared by the write-off (to expense) or the found resolution (back to inventory).
- FR-INV-011's "approval of a large variance" is met at write-off rather than at receipt. The SRS wording is read this way in A-139.
