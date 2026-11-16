# B07 continued: the supplier register and requisitions (phase split)

Date: 2026-11-15 · Branch `b07b-supplier-register`, from `main` (`7c5ff13`) · Pull request #43 · Status: **phase split (A-167, approved). The gate's first part passed, with the owner's three procurement decisions (A-168 to A-170) and the owner's answer to my stop (A-171).** The session stopped once, on the Owner role, and resumed when the owner answered (see "The stop and its resolution").

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-166 | **How the supplier register and requisitions are built, taking the most conservative reading.** (a) **Every payout change needs a different person's approval, the first set included.** Terms sent in the same request wait with the details (the contract's 202 says nothing takes effect); terms sent alone apply at once; one change waits per supplier; the checker needs `pur.supplier.payout_approve` with a fresh step-up (the Owner only, after A-169), never the maker. (b) **Held at the head office**: suppliers belong to no branch, so a payout change is registered and approved at the first live non-test branch (`MasterDataRefs.headOfficeBranchIn`, the rule MDM's imports use). (c) **Each change is a document** (`pur.supplier_payout_change`) with the sealed details and the masked form; the profile points at the approved change in force. (d) **A payment pays the details in force when prepared**: a bank or mobile money payment records them and is refused without approved details of its method (this tightens B7's payments); cash and cheques need none, a cheque is made out to the registered name. (e) **Full details are decrypted** only by the new `getSupplierPayoutDetails` (own permission, step-up, audited `DECRYPT`), so the checker can confirm before approving. (f) Profiles open in the supplier's registration transaction; categories and contact persons stay MDM's; MDM's `Supplier.hasProfile` stays false (BL-058). (g) An invoice's due date defaults to its date plus the payment terms. (h) Documents attach a `CLEAN` `SUPPLIER_DOCUMENT` upload; expired dates are refused; the expiry reminder waits for B11. (i) Requisitions are in base units at a named location or the requester's one grant scope; converting needs `pur.purchase_order.create` and `pur.requisition.approve`; no cancel operation yet. (j) Grants as below. | Owner (a, b, j); accountant (d, g) |
| A-167 | **B07 continued split at a sub-domain boundary.** This phase built the supplier register and requisitions. **B07 continued 1b** (`b07b2-supplier-credit-scores`) builds credit notes with the supplier-return movement (FR-PUR-011), the approved variance (FR-PUR-010), remittance data (FR-PUR-013) and scores (FR-PUR-014), and carries the gate's rest. Recorded in ADR-0026 Amendments and the openers; B07 continued 2 now reads the B07 continued 1b report. | Owner |

| A-168 | **Owner's decision: the approval limit is a setting, and order splitting is flagged.** `pur.purchase_order.approval_limit_pesewas` (platform `Settings`, effective-dated, default 200,000), read fresh on submit; changed only by AUD's new `updateSetting` (Owner, fresh step-up, audited before and after). Order splitting: 2 or more orders by one maker to one supplier within **7 days**, each at or below its limit and **no more than 20 percent under it**, together above it, flagged by `PurchaseOrders.splitSuspectsIn` for B12 (threat model case 27; B12's opener now says the report must include it). | Owner (window, margin) |
| A-169 | **Owner's decision: no single role both changes payout details and approves or records a payment.** Every PUR grant was checked, B7's included. First split (0103): the Accountant gave up approving payout changes, and a new permission, `pur.supplier.payout_change`, went to the Owner only. The Owner still held both sides, which stopped the session; **resolved by the owner** through A-171, which replaces that split with cross-approval. | Owner |
| A-170 | **Owner's decision (confirmed again in the answer): the first payment after a payout change needs a second approver, whatever the amount.** The database marks the first live payment to a supplier since the approved change in force (`payout_first_use`) and refuses its approval or payment without an approval request; the summary says why. Every payment already needs a second person (FR-PUR-012), so "the normal limit" is the `SUPPLIER_PAYMENT` policy, which always asks today; the new rule stands on its own. | Owner |

| A-171 | **Owner's answer: cross-approval and a person-level bar.** The Owner holds both sides at role level (ADR-0043 and A-120 unchanged). A payout change by the Owner is approved by a Manager or an Accountant, and one by either of them by the Owner, always a different person. So the Manager and the Accountant now ask for and approve payout changes, and the Manager also reads full payout details and prepares payments (migration 0106). Whoever made a payout change may not approve the first payment after it (422 `PAYOUT_MAKER_CANNOT_APPROVE`), in the domain and the database (migration 0105). They may still prepare it, and the change's approver is not barred. The seed now puts payout details in force: the seeded Owner makes each change and the seeded Manager approves it. | Owner |

## The stop and its resolution

**The stop.** The owner's condition A-169 (no role both changes payout details and approves or records a payment) could not hold for the Owner role. IAM refuses anyone granting a role holding a permission they do not hold (A-120; ADR-0043), and the Owner grants every role. Taking either side from the Owner broke the seed. Relaxing the rule would have contradicted ADR-0043, so I stopped with pull request #43 open and unmerged.

**The resolution (owner, 2026-11-15).**
1. The Owner role keeps both sides; ADR-0043 and A-120 stand.
2. Payout changes are cross-approved between the Owner and a Manager or an Accountant, always by a different person.
3. A narrow person-level rule applies: the maker of a payout change may not approve the first payment after it.
4. A-170 stays.
5. The B07 continued 1b split is approved.

Built on the same branch, test first. The person-level tests were seen red: 8 of 33 failed on the old grants and with no rule. They prove:
- **The smallest team.** The Owner makes the change and the Manager approves it; the Owner prepares the first payment and the Manager approves it.
- **The Owner is barred on that path.** The Owner approving the first payment, prepared by the Accountant, is refused with `PAYOUT_MAKER_CANNOT_APPROVE`; the change's approver then approves it.
- **The mirror case.** The Manager makes the change and the Owner approves it; the Manager prepares the payment and the Owner approves it. The Manager approving the first payment after their own change is refused.
- **The Accountant.** An Accountant's change is approved by the Owner.
- **The database.** It refuses the change's maker as approver (HK010).

**A difference from the owner's wording, for the owner to see.** The owner asked to replace the role-level test with these person-level ones, and to keep "the proof that no role other than the Owner holds both". That proof cannot stay true. The owner's mirror case has the Manager making a payout change and preparing a payment, so the Manager holds both sides. The Accountant, who approves and makes changes and prepares and pays payments, holds both too. The role-level test now proves the narrower fact that remains: no role outside the Owner, the Manager and the Accountant holds any payout permission, so none outside them holds both. Its grant table pins exactly who holds what (A-171(d)).

**Needs the owner's approval:**
- **The split.** One more continued phase before the storefront.
- **The payout rule.** Even the first payout details wait for a second person; terms sent with them wait too.
- **Payments now need payout details.** A bank or mobile money payment is refused until the supplier has approved details of that method; this tightens what B7 shipped.
- **The grants (after A-169).**
  - Supplier terms and documents: the Owner, the Manager and the Accountant.
  - Asking for and approving a payout change: the Owner, the Manager and the Accountant, always a different person; the maker never approves the first payment after it.
  - Full payout details: the Owner, the Manager and the Accountant.
  - Supplier payments: the Accountant and the Manager prepare, the Accountant pays, the Manager approves; the Owner holds all three.
  - Setting administration: the Owner.
  - Requisitions: raised by the Storekeeper, the Farm hand, the Manager and the Owner; rejected or converted by the Manager and the Owner.
- **Order splitting's window (7 days) and margin (20 percent).**
- **No new dependency.**

**No ADR conflict remains.** A-169 conflicted with ADR-0043 for the Owner role; the owner resolved it without changing ADR-0043 (A-171). There is no new ADR and no new port. AUD is created now (layer 3, imports platform and IAM) for FR-AUD-007's `updateSetting`, which B3 was assigned and never built. The profile subscriber is the transactional kind ADR-0010 allows (a module keeping its own aggregate consistent with a lower module's fact), as MDM's `mdm.SupplierRegistered` already said procurement would do. Encryption follows ADR-0022 (application-side, per-subject key, decrypted only in the owning module for a permission, audited). Documents use ADR-0044's file store unchanged. ADR-0047, ADR-0051 and ADR-0052 are untouched.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B07 continued (`b07b-supplier-register`, from `main`).
2. **Scope:** FR-PUR-001 to FR-PUR-004, FR-PUR-010's approved variance, FR-PUR-011, FR-PUR-013's data and FR-PUR-014. It was too large for one context, so it was split after the register and requisitions, at a sub-domain boundary, at a green commit.
3. **Gate:**
   - A payout detail change returns 202, the old details stay in force until a different person approves, and the column is ciphertext (built here).
   - A document whose content is not what its name says is refused (built here).
   - A rejected requisition cannot be converted, and a converted one links its order (built here).
   - Every write refuses the wrong role (built here, for every write this phase made).
   - A credit note cannot exceed the invoice's uncredited amount; the score matches FR-PUR-014 (moved to B07 continued 1b).

## Contract changes

**Version 1.29.0, minor. No existing field was removed, renamed or retyped.**
- **Counts:** 295 operations from code, 336 planned, 631 published.
- **From code now (12):** `updateSetting` (AUD), and `getSupplierProfile`, `updateSupplierProfile`, `listSupplierDocuments`, `addSupplierDocument`, `listPurchaseRequisitions`, `createPurchaseRequisition`, `getPurchaseRequisition`, `updatePurchaseRequisition`, `submitPurchaseRequisition`, `rejectPurchaseRequisition`, `convertPurchaseRequisition`.
- **New operation (1):** `getSupplierPayoutDetails` (`GET /suppliers/{id}/payout-details`), with the schemas `PayoutDetailsView`, `PendingPayoutDetails` and `SupplierPayoutDetails`.
- **New response fields (required):** `SupplierPayment.payeeDetailsMasked`; `PurchaseRequisition.location` and `.rejectReason`.
- **New optional request field:** `PurchaseRequisitionCreate.locationId`.
- **New error codes:** `SUPPLIER_PROFILE_INVALID`, `SUPPLIER_DOCUMENT_INVALID`, `PURCHASE_REQUISITION_INVALID`, `SETTING_INVALID`; and `PAYOUT_DETAILS_MISSING`, `PAYOUT_METHOD_DIFFERS` under `SUPPLIER_PAYMENT_INVALID`.
- **Behaviour on existing operations:** a bank or mobile money `createSupplierPayment` needs approved payout details of that method; a new invoice's `dueDate` defaults to its date plus the payment terms; `submitPurchaseOrder` judges the order against the limit setting; a payout change needs `pur.supplier.payout_change`; the first payment after a payout change always waits for a second person.
- **Examples:** payout details in every example are now obviously fictional; the 202 example names `SUPPLIER_PAYOUT_CHANGE`.
- The changelog entry and the cold-read summary are written. Redocly lint is clean, and `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0097:** document types `SUPPLIER_PAYOUT_CHANGE` and `PURCHASE_REQUISITION`.<br>**0098:** `pur.supplier_payout_change` (DOCUMENT), `pur.supplier_profile` and `pur.supplier_document` (MASTER), and `supplier_payment.payout_change_id`. Database rules:<ul><li>a change starts PENDING_APPROVAL, is decided once, and its content never changes (HK004);</li><li>`ck_supplier_payout_change_checker`: an approval by the maker is refused on the row;</li><li>one pending change per supplier;</li><li>the details in force are an approved change of the same supplier, never removed (HK010);</li><li>a bank or mobile money payment pays the approved details of its method in force, a cash or cheque payment none, and the payee never changes (HK010, HK004);</li><li>one stored file is filed once.</li></ul>**0099:** `pur.purchase_requisition` and its lines: the lifecycle guard, `ck_purchase_requisition_converted`, `ck_purchase_requisition_rejected`, lines fixed after DRAFT.<br>**0100:** 7 permissions and the `SUPPLIER_PAYOUT_CHANGE` policy (always, step-up).<br>**0101:** grants.<br>**0102:** `pur.supplier.payout_change` and `aud.setting.manage` (step-up).<br>**0103:** the A-169 regrant (the Accountant loses payout approval; the Owner gains the payout request and the setting administration).<br>**0104:** `supplier_payment.payout_first_use`, set by the database, with `ck_supplier_payment_first_use`.<br>**0105:** `payout_first_use_change_id` and `pur.supplier_payment_first_approver` (the change's maker never approves the first payment, HK010).<br>**0106:** the cross-approval grants (A-171). |
| MDM | `MasterDataRefs.headOfficeBranchIn`. |
| AUD (new, layer 3) | `SettingsAdmin.update` (`updateSetting`): the catalogue in `aud/domain/setting-catalogue.ts` (100 percent gate), a new effective-dated row through platform `Settings.insertIn`, audit before and after. |
| Platform | `Settings.integerAt` (fresh, effective-dated), `rowIn`, `insertIn`. |
| PUR domain (100 percent gate) | `payout-details.ts` (each method's fields, the masked form, which details a payment pays), `requisition.ts` (lifecycle, conversion lines), `terms.ts` (due date from terms), `order-splitting.ts` (A-168), and in `purchasing.ts` the limit judgement and the payment approval reason (A-170). The specs were written first and seen red (missing modules or functions). |
| PUR application, infrastructure and interface | `Suppliers` (profile, payout change and its approval handler, full read with `DECRYPT` audit, documents, the `mdm.SupplierRegistered` subscriber), `Requisitions` (conversion through `PurchaseOrders.createIn` in one transaction), `PgSupplierRegisterStore`, `SupplierRegisterController` (12 routes), strict zod schemas. `SupplierPayments` pays the details in force; `SupplierInvoices` dates from terms. Every handler authorises first, claims the idempotency key, runs serializable, audits (payout fields encrypted with the supplier's key in the audit), and publishes through the outbox: `pur.SupplierPayoutChangeRequested`, `pur.SupplierPayoutChanged` (both carrying THREAT_MODEL case 13) and `pur.RequisitionSubmitted`. |
| Seed | `farm-pur-register.ts`, after B7's unit. Kpone sells on 14-day terms with a 3-day lead time and is paid by MTN mobile money (`****0211`); Awutu by Ecobank transfer (`****0202`); each change made by the seeded Owner and approved by the seeded Manager, through the services (A-104, ADR-0041: no conflict). The Manager raises and submits a requisition for 100 kg of broiler grower feed at the feed store. No stock or money moves, so the B5 hand count is unchanged. |
| Docs | A-166, A-167, BL-058; ADR-0026 Amendments; the openers (table, a note under B07 continued, the new B07 continued 1b section, B07 continued 2 reads its report); the as-built note in `docs/data-model/pur.md`; the PUR card; `DOMAIN_MODEL.md` 5.7; `API.md` (the B07 continued section and the codes); the SRS traceability rows; threat model case 13; the changelog. |

## Contract requests

The frontend's `main` lists CR-001 to CR-019 (fetched 2026-11-15), the same as at B7. None of them concerns procurement.
- **CR-019** (server-side sort): **declined here** because it is outside this phase's scope. It stays parked as BL-057.
- **CR-005**: standing decline.
- The rest were answered in earlier phases.

## Security review (hakorem-security-review)

Written into the pull request. `docs/security/SECURE_CODING_STANDARDS.md` was run item by item.
- **Boundary:** TB2, the back office, and the database.
- **SC-01 input:** strict zod schemas on every body; payout fields are bounded strings and the domain checks each method's fields.
- **SC-02 authorisation:** deny by default in every handler. Suppliers are farm-wide (any grant of the permission); requisitions are scoped to their branch and location, and lists are narrowed to the reader's grants. Converting checks both permissions. The handler walk covers all 12 routes; the wrong roles are refused on every write, and the Manager is refused the full payout details.
- **SC-03, SC-04:** parameterised SQL only; no dynamic SQL.
- **SC-05 money:** no arithmetic on pesewas here except the conversion's order lines, which reuse B7's line anchor (20 at 5,500 is 110,000).
- **SC-06:** every write takes an idempotency key.
- **SC-07, SC-08 secrets and logs:** payout details never reach a log, the outbox, an approval summary or the audit trail in clear; a test searches the table, the audit bytes, the outbox and the approval summaries for the account number and finds none.
- **SC-09 to SC-11:** unchanged mechanisms; the routes use the console rate limit group.
- **SC-12 uploads:** documents use the existing upload path; an executable named `.pdf` is refused with 415 at upload; only a `CLEAN` `SUPPLIER_DOCUMENT` file is filed; links live 5 minutes.
- **SC-13, SC-19:** not applicable (no webhook, no outbound URL).
- **SC-14:** no external call inside a transaction.
- **SC-15, SC-16:** no empty catch; database refusals map to stable codes.
- **Segregation (A-169):** the payout side and the payment side are held by different roles, except the Owner (stop reason); tested from the grants themselves.
- **SC-17 maker and checker:** IAM refuses the maker (tested: the Accountant cannot approve the Accountant's change), and `ck_supplier_payout_change_checker` refuses it on the row (tested with direct SQL).
- **SC-18 encryption:** AES-256-GCM under the supplier's subject key, bound to the row; decrypted only in PUR, only by `getSupplierPayoutDetails` with `pur.supplier.payout_read` and a fresh step-up, each read audited as `DECRYPT` (tested).
- **SC-20, SC-21:** no new dependency.
- **SC-22 to SC-24:** no stock or ledger table here; serializable commands; audit in the business transaction with before and after.
- **Abuse case 27 (order splitting, new):** the limit changes only with step-up and audit; `splitSuspectsIn` flags the pattern for B12 (tested both ways).
- **Abuse case 13 (payout diversion):** the control is tested (202, old details in force, a payment prepared meanwhile pays the old wallet, the maker refused, the Manager refused). The detection reaches the exception report's sources: `pur.SupplierPayoutChangeRequested` and `pur.SupplierPayoutChanged` carry the case number, maker, approver and the masked old and new details (tested in the outbox); the report itself is B12's. The threat model row is updated.

## Deferred

- **B07 continued 1b:** FR-PUR-011 (credit notes with the supplier-return movement), FR-PUR-010's approved variance, FR-PUR-013's data, FR-PUR-014 (scores and the `inv.GoodsReceived` consumer).
- **B8:** requisition numbers; posting PUR's ◆ events.
- **B11:** the document expiry reminder.
- **B12:** the payout change report and the exception report items from the two payout events.
- **BL-058:** MDM's `Supplier.hasProfile`.
- **Not built:** a requisition cancel operation (none in the contract); per-role order limits (`iam.role_limit`) and PUR's `LocationUsageCheck`, both still open from B7.
- **Owner dashboard:** the purchases tile still reads goods receipts; nothing here changes what "purchases" means.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **948 passed** (30 new: `payout-details`, `requisition`, `terms`, `order-splitting`, the limit and payment reason in `purchasing`, AUD's `setting-catalogue`, and `judgeFirstPaymentApprover`). |
| Integration | **892 passed**. New: `pur/supplier-register` (31), `pur/procurement-segregation` (2). Updated: the handler walk, B7's `purchase-to-pay` (a wallet before a mobile money payment), the seed unit kinds. |
| Coverage, merged | 1,840 passed. Statements 93.39, branches 82.94 percent (gate 80). Every 100 percent gate holds, including `src/modules/pur/domain/**` and the new `src/modules/aud/domain/**`. |
| Contract | **72 passed**. New: `b7/supplier-register.contract.spec.ts` (2). Updated: the drift counts (295 and 336), the request-schema map (seven writes), B7's contract test pays Kpone in cash. |
| Lint, typecheck, Redocly, `contract:generate --check` | Clean |
| End to end | CI only (not run locally) |

**Test first, honestly:**
- The domain specs (`payout-details`, `requisition`, `terms`, and for the owner's decisions `order-splitting`, the limit and payment reason in `purchasing`, AUD's `setting-catalogue`) were written before the domain code and seen red (missing modules or functions).
- The segregation test was written first and seen red (both its tests failed on the grants of 0096 and 0101), then 0103 was written.
- The integration test was written after the application layer, before any of it ran. Its first run was red, 18 of 20, and exposed two real bugs, both fixed: the register store's updates did not bump `version` for `touch_version`, and the test's own fixtures named suppliers the seed does not have.
- B7's payment tests needed the new rule: B7's integration test first puts Kpone's wallet in force (one Owner asks, a second approves), and B7's contract test now pays Kpone in cash. Nothing was skipped or loosened.
- Putting the payout request on the Storekeeper failed the IAM test that a Manager holds every Storekeeper permission; the request is the Owner's alone.
- Taking the Owner's payment permissions failed the seed (`RoleExceedsGranterError`), which is the stop reason; that change was not kept.
- I saw no flaky test.

## Gate

**First part passed, with the owner's decisions and answer.** Each point was proved by a test on this machine (`test/integration/pur/supplier-register.integration.spec.ts`):
- **Payout change:** Awutu's MTN wallet `****0014` is in force; an Owner asks for a Telecel wallet with 7-day terms and gets 202 `SUPPLIER_PAYOUT_CHANGE`. The profile still shows `****0014` and 0-day terms; a payment prepared then pays `****0014`. A second change is 422 `PAYOUT_CHANGE_PENDING`; that Owner approving is 422 `MAKER_CANNOT_CHECK`; the Storekeeper is 403. When a second Owner approves, `****0777` and 7 days are in force; the earlier payment still pays `****0014` and a new one pays `****0777`. A rejected change leaves the details as they were.
- **Ciphertext:** the stored column holds neither the account number nor the bank name, and no number appears in the masked form, the audit bytes, the outbox or the approval summaries. The full read needs a fresh step-up (403 `STEP_UP_REQUIRED` five minutes after login) and writes one `DECRYPT` audit row per read. The database refuses a profile pointing at another supplier's or a rejected change (HK010), a change to a decided change (HK004), a maker's approval on the row (23514), and a change of a payment's payee (HK004).
- **Disguised document:** an executable named `health-certificate.pdf` is refused at upload with 415 `FILE_TYPE_NOT_ALLOWED`. A scanned PDF is filed and listed and its link expires after 300 seconds; an unscanned file, a file of another purpose, the same file twice and an expired date are each refused.
- **Requisitions:** the Farm hand's 20 broilers at the pens converts into a DRAFT order of 20 at 5,500 (110,000) that the requisition links; converting again is refused. A rejected requisition answers 422 `INVALID_STATE_TRANSITION` to conversion and keeps no order. The database refuses a converted requisition without an order, a line change after submission, and a step back to DRAFT.
- **Wrong roles:** refused on every profile, payout, document and requisition write; the Storekeeper and the Farm hand cannot reject or convert.
- **Approval limit (A-168):** the Manager is refused `updateSetting`; the Owner is refused five minutes after login (`STEP_UP_REQUIRED`); -5 is `OUT_OF_RANGE`; an unknown key is 404; with a fresh step-up the Owner sets 100,000 (a later 50,000 dated a week ahead does not apply yet), a second write at version 0 is 409, and the audit row shows 200,000 (default) to 100,000. Then 20 broilers at 5,500 (110,000) answers 202 and 20 at 5,000 (100,000) is approved on submit.
- **Order splitting (A-168):** three orders of 190,000 to Awutu by one storekeeper two days apart are flagged as one run of 570,000; three to Kpone ten days apart are not (and the domain tests cover the margin, the window, other makers and suppliers, and each order's own limit).
- **First payment after a change (A-170):** a 500-pesewa payment right after Dodowa's wallet change is marked by the database, cannot be marked paid before approval, and its approval summary names the rule; once approved and paid, the next 500-pesewa payment is not marked and follows the payment policy. A rejected first payment does not count. The flag cannot be changed (HK004).
- **Grants and the person-level bar (A-169, A-171):** the five tests under "The stop and its resolution" pass; no role outside the Owner, the Manager and the Accountant holds a payout permission; the Storekeeper is refused a payout change, its approval and the full details.
- **Rest of the gate (credit note cap, score):** not built; it is B07 continued 1b's gate.

## Notes for the frontend track

- The supplier profile, payout change, documents and requisition screens can use the real API.
- Payout changes are cross-approved between the Owner, Managers and Accountants; the change's maker gets 422 `PAYOUT_MAKER_CANNOT_APPROVE` on the first payment after it, so offer that approval to someone else.
- The approval limit is a setting the Owner changes with `updateSetting` (step-up).
- Show payout details masked only; open `getSupplierPayoutDetails` only for the checker, after a step-up, and do not keep it.
- Any payout change is 202: show "waiting for approval" from `pendingPayoutChangeApprovalId`.
- A supplier payment by bank or mobile money needs approved details of that method first; show `payeeDetailsMasked` on the payment.
- Requisition quantities are in the product's base unit (`uom` on each line).
- `Supplier.hasProfile` stays false; use `getSupplierProfile`.
- Credit notes, scores and remittance data stay mock-only (B07 continued 1b); the storefront follows in B07 continued 2.

## CI

Before the stop, CI ran on `9e14797` (pull request #43) and was green:
- run 43771959444, `push`, success;
- run 43771988578, `pull_request`, success.

The stopped report's head, `5969535`, was also green:
- run 43772421169, `push`, success;
- run 43772426977, `pull_request`, success.

The owner's answer (A-171) is built in the commits after `5969535`, and this report's commit is the new head. A commit cannot name its own runs, so the runs on that head, and `main`'s `push` run on the merge commit, are listed in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B07 continued 1b, copied from `docs/prompts/session-openers.md` (written by this phase's split, approved by the owner).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07b-supplier-register.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PUR-010, FR-PUR-011, FR-PUR-013 and FR-PUR-014 in the PUR block of docs/SRS.md (nothing else
from the SRS), docs/data-model/pur.md (its "As built" notes first), the PUR and INV cards in docs/MODULE_BOUNDARIES.md,
ADR-0017, ADR-0020, ADR-0043 and A-164, A-166 to A-170 in docs/ASSUMPTIONS.md (A-168 to A-170 are the owner's
decisions of 2026-11-15; first apply the owner's answer on A-169's Owner role, if the B07 continued report records
one). Use docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money, hakorem-stock (the supplier
return), hakorem-security-review (the variance approval) and hakorem-migration.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued 1b only, on branch b07b2-supplier-credit-scores, branched from main: supplier credit notes
(createSupplierInvoice with kind CREDIT_NOTE) against an invoice's uncredited amount, held by the database, reducing
what is payable, with a supplier-return movement through INV's published interface where goods go back and the
ledger event for B8 (FR-PUR-011); the approved variance that lets a mismatched invoice be paid, approved by a different
person (FR-PUR-010); the data of the remittance advice for a paid payment, answered once per payment (FR-PUR-013;
rendering waits for B8); supplier scores from receipts, rejections, lead times and invoice prices with the weights 30,
25, 25 and 20 held as settings (FR-PUR-014). Write the money, permission and approval tests first; extend the seed;
changelog and cold-read summary for every contract change. Stop at the gate, write
docs/sessions/B07b2-supplier-credit-scores.md, and merge into main when every run on the pull request is green.
```
