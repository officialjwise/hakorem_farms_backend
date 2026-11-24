# B11 continued 9: part of a crate returned as single eggs (lane B), split before notifications

Date: 2026-11-24 · Branch `b11c9-returns-notifications`, from `main` at `a5177c2` (#136, B11 continued 8) · Status: **phase split (A-373) at the boundary between returns and notifications: part of a crate returned as single eggs, refunded pro rata at the price paid, built to its own gate, passed locally; CI below. Notifications (the NTF module), CR-039, CR-033 point 3, the reused-photograph match and the UAT dry runs are B11 continued 10.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-372 | **Part of a crate returned as single eggs** (the owner, 2026-11-18). (a) A return line may name `uom`, the product's base unit, on a line sold per unit in a unit of several (from MDM's exact whole conversion, kept on the line as `pieces_per_unit`, 30); any other unit `UNIT_NOT_SOLD`; whole pieces only (`INEXACT_QUANTITY`). (b) The refund is a credit by amount on the original line: ADR-0075's running total on the line's anchor (its gross on a tax-inclusive document, its net otherwise, then taxed by the original's scheme): round(paid x (previous + returning) / pieces sold) less round(paid x previous / pieces sold), previous counting every decided return of the line in pieces. Whole units keep the quantity credit as before. (c) **Conservative:** a return in pieces is refused while another return of its line is open, and a line with one open takes no other (`RETURN_OPEN_ON_LINE`, held by the database too), so the refund the approver sees is the one paid and the pieces always add up; whole crates beside whole crates may still wait together as before. (d) Single pieces go to the returns hold or are written off, never `RESTOCK` (`PART_RETURN_TO_HOLD`). (e) A line under one pesewa a piece would be refused by BIL's amount rule (none is priced so). (f) On a tax-exclusive invoice the last piece may meet BIL's cap a pesewa early if the credit's taxes round up (eggs are VAT-exempt). | Owner |
| A-373 | **The split.** Returns built to their own gate; stopped before notifications, because the NTF module does not exist (no code, no migration; sixteen planned operations) and would not reach its gate in this context. **B11 continued 10** (`b11c10-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order, B12's reused-photograph line). | Parent session |

**For the parent session to schedule:** B11 continued 10 (all of NTF with the customer messages, the document sends, CR-033 point 3's receipt SMS, the tracking SMS, the reminder templates and delivery per channel; CR-039 at the shop; the reused-photograph match; the UAT dry runs). Its opener says how to split it if needed. **CR-039** is not NTF (it is SHP's cart and catalogue) but stays in B11 continued 10 as the opener ordered.

**No ADR conflict, and no stop.** ADR-0075 is applied as written (half-up, running total). ADR-0066 (returns: maker never approves, the credit note made by the maker under the approval, the refund asked as the maker) unchanged. ADR-0081: returned eggs only come in; nothing goes below zero. ADR-0067: no `now()` in the migration's business SQL. **Shared modules, additive only:** no function of BIL, PAY, INV, IAM, POS or FIN changed: ORD uses BIL's existing amount credit (`CreditNoteRequest.lines[].amountPesewas`, `creditPreviewIn`, `creditIn`, `viewsIn`) and INV's existing `returnSaleIn`.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 9, lane B (`b11c9-returns-notifications`, from `main` a5177c2).
2. **Scope:** the opener's sub-domains in order (returns of part of a crate, then notifications with CR-039, CR-033 point 3, the reused-photograph match and the UAT dry runs), splitting at the boundary between them if the context will not reach the next gate.
3. **Gate (this part):** part of a crate returned as single eggs is refunded pro rata with the pieces adding up (917 for five eggs of a GH₵55.00 crate; exactly 5,500 for all 30 one at a time), never twice, never above the line, under concurrency. **Passed** (below). The rest of the opener's gate (the customer messages, each once) is B11 continued 10's.

## Contract changes

**2.38.0, minor, LOUD on one answer field** (on top of 2.37.0; Redocly clean, no warnings; `contract:generate`: 548 operations from code, 117 planned; no operation added).
- **New optional request field:** `ReturnLineInput.uom` (`createReturn`). New refusals (`ORDER_INVALID`): `UNIT_NOT_SOLD`, `INEXACT_QUANTITY`, `PART_RETURN_TO_HOLD`, `RETURN_OPEN_ON_LINE`.
- **LOUD, `ReturnLine.uom`** (new, always sent) on `createReturn`, `getReturn`, `submitReturn` and the planned `listReturns`: the unit `qty` counts.
- `createReturn`'s description now says how part of a crate comes back (it said "comes in a later phase").
- No permission added. No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| ORD domain | `pieceRefund` (the running total, half-up once); `judgeReturn` counts a line sold in a unit of several in pieces (`piecesPerUnit`, `piecesReturned`): eggs and whole crates against each other, whole pieces, never `RESTOCK`, never open beside another return of the line. |
| ORD application | `Returns.create` reads what each line holds in whole units and pieces (`ReturnStore.heldOf`, replacing `returnedOf`), the line's pieces per unit from MDM's conversion, and previews the credit by amount for a line in pieces at the price on the original line (`pieceAmountsIn`, BIL's `viewsIn`); the approval recomputes it over the decided returns and credits it through `Billing.creditIn` by amount; the eggs back into stock in the base unit through INV's `returnSaleIn`; `ReturnLine.uom` on the view; the approval's hash binds `uom` and `piecesPerUnit` when set (unchanged otherwise). |
| Schema | 0334 (ORD): `ord.order_return_line.uom`, `pieces_per_unit`, `ck_order_return_line_pieces`; `ord.order_return_line_guard()` counts the cap in pieces once a line has any return in pieces, one count per line, and refuses a return in pieces open beside another open return of its line (`ck_order_return_line_open`), under the sold line's row lock. Rolls back (the rollback walk names it). |
| Docs | A-372, A-373; abuse case 56; ADR-0026 Amendments; `data-model/ord.md`; API.md (ORD); the SRS trace row of FR-ORD-015; the 2.38.0 changelog; the openers (B11 continued 9 built and split, B11 continued 10 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/ord/eggs-returned.integration.spec.ts` (5 tests, new, over the seeded farm; the crate at GH₵55.00 is a new version of the seeded base prices made by the Manager and approved by the Owner, so the sale's paid price is 5,500; every figure read back by SQL):
- **Refusals:** the Storekeeper and the Investor 403; 2.5 eggs `INEXACT_QUANTITY`, eggs to `RESTOCK` `PART_RETURN_TO_HOLD`, `KG` `UNIT_NOT_SOLD`; nothing written.
- **Five eggs of a GH₵55.00 crate refund exactly 917:** the return line 917 (`uom` EGG, `pieces_per_unit` 30), the approval's summary "GHS 9.17"; the maker cannot approve (403); approved by the Owner: the credit note's gross 917, the refund 917 asked by the cashier (the maker), five eggs into the returns hold; trial balance 0.
- **A crate returned one egg at a time, all 30:** the pieces 183, 184, 183, 183, 184, 183, ... summing to **exactly 5,500**; credit notes 5,500, refunds 5,500, 30 eggs in the hold; a 31st egg and a whole crate more are `RETURN_EXCEEDS_SOLD`; trial balance 0.
- **Concurrency and the database:** two returns of 20 eggs of one crate at once leave one (the other `RETURN_OPEN_ON_LINE`); straight into the table as `hk_app`: a second open return of the line `ck_order_return_line_open`; once the first is decided, 11 more eggs past the crate `ck_order_return_line_cap`, 2.5 eggs `ck_order_return_line_pieces`, 10 eggs taken.
- **Never refunded twice:** two approvals of one return at once: one 200, the other refused; one credit note, one refund of 917.

Unit: `ord/domain/order-return.spec.ts` (+10): five eggs 917; all 30 one at a time 5,500 (and the first six pieces); the second five 916; half exactly, one below and one above half; nothing on a line that cost nothing; the largest amount whole and in two pieces; the cap with eggs and whole crates against each other; whole pieces; the unit; the hold; the open return.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | Each egg rounded on its own (`pieceRefund` as round(paid / pieces) x returning) | red: 5 of 20 (unit), 3 of 5 (eggs-returned) |
| M2 | The single-egg price (220 an egg) instead of the crate's price per egg | red: 3 of 5 (eggs-returned) |

## Test first, as it honestly happened

- The domain tests were written and run red first (9 failing: `pieceRefund` did not exist), then the code.
- The integration spec was written against the gate and run red before the application code (every test 400 `UNKNOWN_FIELD` on `uom`). Its first runs found two faults in the test set-up and one in the migration, all fixed before the code: plpgsql reads an `IF` condition to the first `THEN`, so a `CASE ... THEN` inside it broke the migration (now computed first); an agreed price below the seeded crate floor waits for a price override approval, so the GH₵55.00 crate is put on a new approved version of the base prices instead.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item, applied to the new paths)

Boundary crossed: TB2 back office (`createReturn`, `submitReturn`, the `RETURN` approval), the database.
- **SC-01 input:** strict schema; `uom` a unit-code pattern; unknown fields 400.
- **SC-02 authorisation:** unchanged permissions, in the application layer: `ord.return.create` (the Storekeeper and the Investor refused, tested here and in `order-return`), `ord.return.approve` with step-up, never the maker (tested).
- **SC-03, SC-04:** parameterised SQL only.
- **SC-05 money:** integer pesewas; one half-up rounding per running-total point; the amount is the server's, from the original line, never the client's; BIL caps the line and the document.
- **SC-06 idempotency:** `createReturn` and `submitReturn` by their keys, unchanged.
- **SC-07, SC-08:** no new personal data; the events unchanged.
- **SC-09 to SC-13:** staff session writes with CSRF and origin, the console rate-limit group; no upload, webhook or outbound URL.
- **SC-14:** no external call inside a transaction.
- **SC-15, SC-16:** no empty catch; the trigger's refusals propagate.
- **SC-17 maker and checker:** the return (IAM, `judgeReturnApprover`, `ck_order_return_decided`), the refund (PAY refuses the maker and the credit note's maker).
- **SC-18 to SC-21:** no restricted field, no dependency, no secret-shaped literal.
- **SC-22:** stock comes back only through INV's `returnSaleIn`; the return line's quantities are written once while `REQUESTED`.
- **SC-23:** serializable with the whole-command retry; the order's and the sold line's row locks serialise returns of one line (tested at once).
- **SC-24:** audited (`CREATE`, `SUBMIT`, `APPROVE` with the lines and their `uom`).
- **Abuse paths:** the parent's list, each: **a return refunded twice** (one credit note and one refund per return by unique keys; two approvals at once tested); **a refund larger than the line** (the running total never exceeds the line, BIL's line and document caps, the cap in pieces, all tested); **a refund to a method the customer did not pay with** (unchanged: the refund is against the sale's own cleared payment, `planReturnRefund`, PAY judging the destination); **a message or link sent to the wrong person** and **a reminder storm**: no message is sent in this phase (B11 continued 10's). New abuse case **56** (a return of eggs refunded twice or above what was paid); detection is B12's daily exception report from `ord.ReturnSubmitted` and `ord.ReturnCompleted` (abuse case 12). Cases 57 and 58 are left for B11 continued 10.
- Findings: none open.

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 need the customer messages (NTF), which are B11 continued 10's; its opener names them.

## Reused photographs

Not recorded here; B11 continued 10's opener carries it, and B12's says B12 must if B11 continued 6 to 10 do not.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11 continued 6)

- **CR-039** (the crate and the single egg at the shop) and **CR-033 point 3** (the receipt SMS): B11 continued 10's, in its opener (not declined).
- **CR-038 point 3** (a return of a line sold by the egg refunds by the egg) was answered in 2.11.0; 2.38.0 adds part of a crate returned as single eggs.
- **CR-059 to CR-062:** B12's, in its opener. Older requests are answered in their phases. No request is left without a phase.

## Tests (this machine)

Run on the docs commit just below the report (the code of the final head; the report commit adds only this file) with Docker's Testcontainers; see CI below for the runs on the pushed commits. `main` had not moved from `a5177c2` when the merge slot was taken, so no rebase or renumbering was needed.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **4,196 passed, 350 files, none skipped, exit 0**, the whole integration suite included. Coverage, whole: statements 94.10, branches 83.74, functions 97.86, lines 97.16 (each gate 80). **Every full-coverage gate holds at 100 percent** (the run exits 0 on them; `ord/domain` among them). Unit alone: 2,018 passed (169 files). |
| Contract (`pnpm test:contract`) | 139 passed, 55 files, on 2.38.0 |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (548 operations from code, 117 planned) |

No local run was red after the code was written; nothing was retried or skipped.

## Deferred

- **To B11 continued 10** (its opener): all of NTF (the customer messages from `ord.OrderDispatched`, `ord.OrderCollected`, `del.DeliveryOnTheWay`, `del.DeliveryRescheduled`, `del.DeliveryCancelled` and `del.DeliveryCompleted`; abandoned carts; the returned death report; the document sends and the remittance advice; CR-033 point 3; the tracking SMS; the reminder templates and delivery per channel); CR-039; the reused-photograph match; the UAT dry runs; abuse cases 57 and 58 if needed.
- **Not built, recorded:** a line priced by weight still waits for catch weight's re-pricing (`WEIGHED_LINE_NOT_RETURNABLE`, unchanged).
- **Seed:** nothing seeded (the test makes its own price list version).

## Questions for the owner

1. **A return in single eggs waits for an open return of its line (A-372 (c)).** As built the counter cannot open a second return of the same crate while one waits for approval, so the pro-rata refund the approver sees is exactly what is paid. Agreed, or should returns of one crate be allowed to wait together (the refund then fixed at approval, possibly a pesewa from the preview)?
2. **Single eggs always go to the returns hold or are written off (A-372 (d)).** Agreed, or may a supervisor restock good single eggs at once?

## Notes for the frontend track

- **2.38.0:** the return screen may offer a crate line's single eggs: send `uom: "EGG"` with a whole number of eggs and `RETURNS_HOLD` or `WRITE_OFF`; the answer's `refundPesewas` is the pro-rata refund (never compute it). `ReturnLine.uom` is always sent. A second return of the same crate while one is open is refused `RETURN_OPEN_ON_LINE`: say the first must be approved or rejected first.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 10 (`b11c10-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c9-returns-notifications.md,
B11 continued 9, which this phase continues), and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the DEL and NTF requirement blocks of docs/SRS.md (nothing else from the SRS), docs/data-model/ntf.md,
the ORD, DEL, NTF, SHP, BIL and PAY cards in docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0026 (the abandoned-cart
assignment), ADR-0062 (document sends), ADR-0074 (a link sent by message gets its own token from the sending worker, never
one stored in the outbox), ADR-0093, ADR-0094 and ADR-0095, and the abuse cases 6, 43, 44, 48, 51 to 56 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe (NTF is a new module: load
hakorem-module first). Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 10 only, on branch b11c10-notifications. B11 continued 9 built part of a crate returned as
single eggs (`ReturnLineInput.uom` and `ReturnLine.uom`, 2.38.0; `ord.order_return_line.uom` and `pieces_per_unit`,
migration 0334; the refund round(paid x cumulative / pieces sold) less round(paid x previous / pieces sold) on the line's
anchor; single eggs to the returns hold; `RETURN_OPEN_ON_LINE`; A-372): build on it, never again. The rest, in this order:
1. Notifications (NTF, a new module): through the outbox (SMS, WhatsApp, email, in-app) with templates, triggers,
   preferences, opt-out, quiet hours, the message log and retry, test doubles only (no real provider key) and no outside
   call inside a business transaction; a message only ever goes to the order's own contact (test a wrong recipient is
   impossible): the customer's messages from `ord.OrderDispatched` (one, with the weights and the final total,
   FR-ORD-011; it names a backorder from 2.36.0, and from 2.37.0 an order on account's `dueDate` and the slot booked or
   not), `ord.OrderCollected` (from 2.36.0, `dueDate` from 2.37.0), the on-the-way (`del.DeliveryOnTheWay`, from 2.32.0),
   the rescheduled (`del.DeliveryRescheduled`, from 2.34.0, FR-DEL-003), the cancelled (`del.DeliveryCancelled`, from
   2.35.0) and delivered messages (FR-DEL-012, once per event and recipient; `del.DeliveryCompleted` names a part
   delivery's returned lines from 2.35.0), abandoned-cart messaging (ADR-0026), the death report sent back by the malware
   scan (B06r, A-175: liv.MortalityReturned names the reporter and the reason), the document sends (ADR-0062, A-204:
   sendBillingDocument and sendStatement, 202 through the outbox, a bil.reprint_log row with the channel, the archived
   bytes or a lasting link, never a new document; the remittance advice from pur.SupplierRemittanceReady, once per
   payment; a send reaches only the document's own customer or supplier and a failed send is retried without a second
   archive row), CR-033 point 3 (the receipt SMS once when a counter sale with customerPhone syncs, with a fresh
   server-made token for a sale whose till token was refused, ADR-0074; the refused till token still opens nothing), and
   the guest's SMS tracking link with its own long random token (a guessed token or the order's id answers 404). The
   owner, 2026-11-23 (from the frontend's F12 and F10n): list the message templates so a reminder level picks one instead
   of typing a code, and record each reminder's delivery per channel (sent, delivered, failed), so a failed reminder
   shows as failed. CR-039 at the shop (the crate and the single egg, each at its own price; CartLineAdd.uom; test-first
   with exact pesewas).
Run steps 1.11 to 1.16 of docs/UAT.md, the driver case in scenario 5 and scenario 2 from step 2.12 as a dry run and
record every difference (an order on account can now be dispatched; a crate's eggs can now be returned singly).
For B12's reused photographs (the owner, 2026-11-23): `platform.stored_file` already keeps each upload's SHA-256; record
on the proof of delivery whether its photograph or signature matches an earlier upload (as liv.MortalityPhotoReused
does for a death photograph) and publish it for the exception report. If this phase does not, B12 must; say which in the
report.
Stop at the gate and write docs/sessions/B11c10-notifications.md.
```
