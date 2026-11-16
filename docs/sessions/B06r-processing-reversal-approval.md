# B06r: the processing reversal under approval, the Farm hand's death reports and the tag lookup

Date: 2026-11-15 · Branch `b06r-processing-reversal-approval`, from `main` (`c1437aa`) · Pull request #46 · Status: **gate passed. The phase was not split.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-158 (updated) | **The owner's role matrix change for the Vet or Farm hand, recorded as the owner's decision.**<ul><li>It is the maker of a death report: it finds the animal by its exact tag, reports, uploads the photograph and submits.</li><li>It uploads `EVIDENCE` files and nothing else (`platform.file.upload.evidence`, new).</li><li>It never writes stock off alone. Below the threshold the Owner or a Manager confirms (`liv.mortality.confirm`, new). At or above it, `liv.mortality.approve` with step-up.</li><li>Other reporters keep the direct write-off below the threshold (`liv.mortality.post`, new: Owner, Manager, Storekeeper).</li><li>Death records and money-only reads stay refused.</li></ul> | Owner (decided) |
| A-175 | **How the death reports are built.**<ul><li>**(a) Who confirms:** the confirmer is the Owner or a Manager only, never the Storekeeper. Abuse case 2 names the Storekeeper, and the Storekeeper reads no approval inbox. The opener's "a role that may post a write-off" against its gate's "a manager": the more conservative reading was taken.</li><li>**(b) Uploads:** the Owner and Manager also hold the evidence permission, so that they may grant the role.</li><li>**(c) Scan state:** the application checks the scan at report and submission. The database checks `platform.require_clean_file` at posting, no longer at report: checking a PENDING file in the database would need a new published function, which would widen ADR-0047. A direct write-off that carries a photograph waits for CLEAN.</li><li>**(d) Returns:** done by a scheduled job (`mortality-evidence-returns`, every minute) through IAM's new `Approvals.withdrawIn`. The scanner is unchanged. The Farm hand learns of a return from B11's notification.</li><li>**(e) Reuse:** matched by exact SHA-256 only; records reported before migration 0113 carry no hash.</li><li>**(f) The tag lookup:** at `/care/animal-tags/{tagNo}` under `liv.care.read`, not CR-021's "any of" the record permissions; exact, case-sensitive, live animals only.</li></ul> | Owner (who confirms, the matrix); security (the hash's limit) |
| A-176 | **How the processing reversal follows ADR-0048.**<ul><li>**Value:** the order's total cost.</li><li>**Threshold:** `STOCK_WRITE_OFF`, judged when asked and copied onto the reversal.</li><li>**Approval:** the kind `PROCESSING_REVERSAL`, approved by a different holder of `prc.order.reverse` with step-up. It binds to where the lots and packs stand, so a move voids it. The movements post as the approver.</li><li>**While it waits:** the order refuses packing and a second reversal (`REVERSAL_PENDING`). A rejected reversal frees the order.</li><li>**Refused outright:** in the domain; in the database for a pack that is PICKED, SOLD or WRITTEN_OFF; and for a lot that left the cold room by INV's negative-stock check.</li><li>Reversals posted before migration 0114 keep a null value and threshold.</li></ul> | Owner; accountant (the value judged) |

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B06r (`b06r-processing-reversal-approval`, from `main`).
2. **Scope:** CR-021 (exact tag lookup); the Farm hand's death reports (EVIDENCE-only uploads, confirmation below the threshold, scan state, reused photographs); the processing reversal under ADR-0048; CR-020's examples.
3. **Gate:** the opener's, in full (see Gate below).

## Contract changes

**Version 1.31.0, minor. No field removed, renamed or retyped.**
- **Counts:** 300 operations from code, 335 planned, 635 published.
- **New operation:** `getCareAnimalByTag` (`GET /care/animal-tags/{tagNo}`, `liv.care.read`).
- **New 202 answers:** on `submitMortalityRecord` and `submitCareMortalityRecord` (`MORTALITY_CONFIRMATION`), and on `cancelProcessingOrder` for a completed order (`PROCESSING_REVERSAL`).
- **New enumeration values in responses:**
  - `ApprovalKind`: `MORTALITY_CONFIRMATION`, `PROCESSING_REVERSAL`.
  - `MortalityRecord.status` and `CareMortalityRecord.status`: `RETURNED`.
- **New required response fields:**
  - `MortalityRecord.returnedReason` and `CareMortalityRecord.returnedReason`.
  - `ProcessingOrder.pendingReversal`.
  - On `ProcessingOrder.reversal`: `approvedBy`, `approvalRequestId`, `valuePesewas`, `thresholdPesewas`.
- **New error code:** `EVIDENCE_NOT_SCANNED`. New rule `REVERSAL_PENDING`.
- **Behaviour changes:**
  - The Farm hand's mortality submissions always answer 202.
  - A PENDING photograph is accepted at report.
  - The Farm hand may upload `EVIDENCE` only.
- **Descriptions:** `uploadFile` and the four mortality report and submit operations state the camera-first rule, that the server cannot tell a camera photograph from a gallery one, and that a reused photograph is matched by exact bytes only.
- **Examples (CR-020):** `counting` and `inReview` on `getStockTake` and `listStockTakeLines`.
- **Checks:** the changelog entry and the cold-read summary are written. Redocly lint is clean with no warnings, and `contract:generate` matches the committed file.

## Built

| Area | What |
| --- | --- |
| Migrations | **0111:** three permissions and two approval policies.<br>**0112:** their grants.<br>**0113:** LIV mortality.<ul><li>New columns `confirmation_required`, `returned_reason`, `photo_sha256`; new status RETURNED.</li><li>New checks `ck_mortality_record_confirmed` and `ck_mortality_record_checker`.</li><li>The clean-file check moves to posting.</li></ul>**0114:** PRC reversal.<ul><li>Statuses PENDING_APPROVAL, POSTED and REJECTED.</li><li>New columns `value_pesewas`, `threshold_pesewas`, `approval_request_id`.</li><li>New checks `ck_processing_reversal_approved` and the guard's `ck_processing_reversal_unsold`; `uq_processing_reversal_order` becomes a partial unique index.</li></ul> |
| IAM | `Approvals.withdrawIn` (the owning module withdraws a pending request); the two new approval kinds in the inbox's list. |
| DOC | `Files.uploadFile` checks the purpose: EVIDENCE alone with `platform.file.upload.evidence`, every other purpose needs `platform.file.upload`. |
| LIV | `Animals.getByTag` and its care route.<br>Domain: `judgeSubmission` and `evidenceVerdict`.<br>`MortalityRecords`:<ul><li>The confirmation kind and the scan checks.</li><li>The reuse event `liv.MortalityPhotoReused`.</li><li>`returnIfEvidenceRejectedIn` and `liv.MortalityReturned`.</li></ul>`MortalityEvidenceReturns`: the job, wired in `src/worker-app.ts`. |
| PRC | `Processing` is the approval handler for `PROCESSING_REVERSAL`: judged reversal, pending state, unsold check (also run on approval), payload hash, and the enriched `prc.ProcessingOrderReversed` (abuse case 29).<br>Packing is refused while a reversal waits. |
| Docs | A-158 (owner's matrix), A-175, A-176, ADR-0053 (proposed) and its index line, BL-061.<br>Threat model: case 2 extended, case 29 added, R17.<br>`API.md`, the `liv.md` and `prc.md` as-built notes, `OPERATIONS.md` (the job), the LIV and PRC module cards.<br>ADR-0026 Amendments, the openers' table, and new lines in B11's and B12's openers. |

## Decisions

- **ADR-0053 (proposed):** the Farm hand reports deaths with an EVIDENCE photograph and never writes stock off alone. It covers the purpose-restricted upload, the confirmation kind, the scan state and the reuse detection.
- **The reversal applies ADR-0048 as the owner decided.** No new ADR; the reading is recorded in A-176.
- **No ADR conflict.**
  - ADR-0047 is not widened: no new published database function.
  - ADR-0049 is used for the job.
  - ADR-0052's walk covers the new read.

## Contract requests

The frontend's `main` was fetched on 2026-11-15 and lists CR-001 to CR-021.
- **CR-021: implemented** (`getCareAnimalByTag`), with two differences: the permission is `liv.care.read` rather than "any of" the record permissions, and the path is `/care/animal-tags/{tagNo}`, because `/animals/by-tag/` is ambiguous with `{id}/move` under the lint rule.
- **CR-020: implemented** (examples only).
- **CR-019:** parked for B07 continued 2, as the owner placed it.
- **CR-005:** standing decline.
- **The rest** were answered in earlier phases.

## Security review (hakorem-security-review)

Written into pull request #46. `docs/security/SECURE_CODING_STANDARDS.md` was run item by item.
- **Boundary:** TB2, the back office, and TB8, the database.
- **SC-01 input:** strict zod schemas.
- **SC-02 authorisation:** deny by default in each handler. The upload is checked by purpose before storage. Each wrong role is refused.
- **SC-03, SC-04:** parameterised SQL only.
- **SC-05 money:** integer pesewas.
- **SC-06:** every write takes an idempotency key, and a replay answers the stored 202.
- **SC-12 uploads:** EVIDENCE only for the role; CLEAN is required at approval and at posting.
- **SC-17 maker and checker:** IAM's check plus the two new database checks.
- **SC-22 to SC-24:** stock moves only through INV at serializable isolation.
- **Not applicable:** webhooks, outbound URLs and exports.
- **Abuse cases:**
  - Case 2 is extended.
  - Case 29 is new.
  - R17 is added (a re-saved photograph is not matched).

## Deferred

- **B8:** postings of the reversal (unchanged from A-162, now with its value and approval).
- **B11:** telling the maker a report was returned (`liv.MortalityReturned`); a line is in B11's opener.
- **B12:** the exception items for case 2's reused photographs and case 29's reversals; the lines are in B12's opener.
- **BL-061:** perceptual photograph matching.
- **Seed:** not extended. A seeded death or reversal would change the hand counts of B5 and B05x for no rule this phase needs; the behaviour is proved over the API on the seeded farm.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **982 passed** (5 new in `liv/domain/mortality.spec.ts`). |
| Integration | **933 passed**.<br>New: `liv/farm-hand-death-reports` (16).<br>Rewritten for the new rule: `prc/processing-reversal` (15).<br>Updated for the owner's rule (the Farm hand's submissions now wait for a confirmation): `liv/livestock`, `liv/growth-breeding`, `liv/farm-hand-care` (the walk adds the tag lookup), `doc/file-store` (the Farm hand is refused every purpose but EVIDENCE), and `iam/authorisation` (the handler walk). |
| Coverage, merged | 1,915 passed. Statements 93.42, branches 82.91 percent (gate 80). Every 100 percent gate holds. |
| Contract | **73 passed**. Updated: `b6d/care-packs` (the 202 and its approval) and the drift counts (635). |
| Lint, typecheck, Redocly, `contract:generate` | Clean |
| End to end | CI only |

**Test first, honestly:**
- **Domain specs:** written before `judgeSubmission` and `evidenceVerdict` and seen red (`is not a function`).
- **Integration specs:** written before the migrations and handlers they cover, then run.
- **Failures before green, each fixed in the code or the migration it named:**
  - `iam-location-grants` seed failure: the granter must hold the evidence permission. Fixed in migration 0112.
  - A null-unsafe hash check (`photo_sha256 IS NULL OR ...`). Fixed in migration 0113.
  - The confirmer refused: the Storekeeper has no approval inbox. Fixed by the decision in A-175(a).
  - An approval policy update without its version bump. A mistake in the test itself, fixed in the test.
- **Mutation checks:**
  - With the pack check in `prc.processing_reversal_guard` disabled, the database-only reversal test went red (expected `ck_processing_reversal_unsold`, got none), while the domain tests stayed green.
  - With `ck_mortality_record_confirmed` disabled, its test went red.
  - Both were restored.
- **Flaky tests:** I saw none. Nothing was skipped or loosened.

## Gate

**Passed.** Proved over the real API on the seeded farm:
- **The tag lookup:**
  - `GET /care/animal-tags/FH-G01` answers the goat in `CareAnimal` with no cost key.
  - `fh-g01`, `FH-G0`, `FH-G011` and an unknown tag are each 404.
  - The Storekeeper, Accountant, Cashier, Sales, Driver and Investor are refused (403).
  - Once the goat is DEAD, its tag is 404.
- **Uploads:**
  - The Farm hand uploads EVIDENCE (201, PENDING).
  - The nine other purposes are refused to it (403).
  - The Cashier, Sales, Driver and Investor are refused even EVIDENCE.
- **At or above the threshold:**
  - FH-G01 at 62,000 is reported and submitted by the Farm hand while its photograph is PENDING. The answer is 202 `MORTALITY_WRITE_OFF`, with the goat still ALIVE.
  - The manager's approval is refused with 422 `EVIDENCE_NOT_SCANNED` while the photograph is PENDING.
  - The Farm hand and the Storekeeper are refused as approvers (403).
  - Once the photograph is CLEAN, the manager's approval posts it: the goat is DEAD.
- **Below the threshold:**
  - FH-G02 at 18,000 answers 202 `MORTALITY_CONFIRMATION` and is not posted.
  - The Farm hand, Storekeeper, Accountant, Cashier, Sales, Driver and Investor are refused as confirmers (403).
  - The manager confirms without step-up, and the movement is posted as the manager.
  - The Storekeeper's own FH-G03 at 21,000 posts directly (200).
- **Scan rejected:**
  - INFECTED: the job returns FH-G04 as `RETURNED` (`EVIDENCE_INFECTED`). Its approval is CANCELLED and approving it is `APPROVAL_ALREADY_DECIDED`. `liv.MortalityReturned` names the Farm hand. A second run returns nothing, and the goat can be reported again.
  - FAILED: `EVIDENCE_UNSCANNABLE`.
  - A photograph already rejected is `PHOTO_NOT_USABLE`, at report and at submission.
- **Reuse:** the same bytes uploaded again for FH-G08 publish `liv.MortalityPhotoReused` naming FH-G07's record, `matchedBy: SHA256`, `abuseCases: [2]`.
- **Mortality, in the database:**
  - A confirmation-required record posted without approval is refused (`ck_mortality_record_confirmed`).
  - A record approved and then posted by its reporter is refused (`ck_mortality_record_checker`).
  - Posting with a PENDING photograph is refused (HK008).
- **Reversal at or above the threshold:**
  - G-0142's order at 65,000 answers 202 `PROCESSING_REVERSAL`, and the replay answers the same.
  - `pendingReversal` shows value 65,000 and threshold 50,000. Nothing moves meanwhile.
  - A second request is `REVERSAL_PENDING`.
  - Raising the policy to 100,000 leaves the reversal's 50,000.
  - The maker as checker is `MAKER_CANNOT_CHECK`. The Storekeeper and the five wrong roles are refused (403).
  - The second manager's approval posts it: the goat is back at 60,000, the lots are empty, the packs REVERSED. The output values sum to 65,000. The event carries `needsApproval`, the threshold and `abuseCases: [29]`.
- **Reversal below the threshold:**
  - A 30,000 goat's order at 35,000 posts directly, with threshold 50,000 on the document, and its event.
  - An empty or missing reason is 400.
- **Refused outright:**
  - A pack picked while the reversal waits voids its approval (`APPROVAL_SUBJECT_CHANGED`), and nothing moves.
  - Asked again after rejection, the reversal is `OUTPUT_SOLD`.
  - A sold kilogram is `OUTPUT_SOLD`.
- **Reversal, in the database alone:**
  - A POSTED reversal of an order with a picked pack is refused (`ck_processing_reversal_unsold`).
  - A POSTED reversal at or above its threshold without a different approver is refused (`ck_processing_reversal_approved`).
- **Every write refuses the wrong role** (above, and in the updated walks).

## Notes for the frontend track

- **The Farm hand's death report:**
  1. `getCareAnimalByTag` by the ear tag.
  2. `uploadFile` with purpose `EVIDENCE`, opening the camera directly (not the gallery).
  3. `reportCareMortality` with `photoFileId`, without waiting for the scan.
  4. `submitCareMortalityRecord`, which always answers 202 for this role. Show "waiting for a manager".
- **The approvals inbox:** add `MORTALITY_CONFIRMATION` and `PROCESSING_REVERSAL`. Approval may answer 422 `EVIDENCE_NOT_SCANNED`; offer "try again once the photograph is checked".
- **Returned reports:** a record may become `RETURNED` with `returnedReason`. The Farm hand is told by notification (B11).
- **Processing orders:** `cancelProcessingOrder` on a COMPLETED order may answer 202. Then show `pendingReversal`, and do not offer packing or a second reversal. A posted `reversal` shows `approvedBy`.
- **Stock take review screen:** read `listStockTakeLines`' `inReview` example (CR-020).

## CI

CI ran on `40d2c03`, the pushed head before this report (pull request #46):
- run 43788332439, `push`, success;
- run 43788366241, `pull_request`, success.

A commit cannot name its own runs, so the runs on the final head (this report's commit) and `main`'s `push` run on the merge commit are listed in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B07 continued 2, copied from `docs/prompts/session-openers.md` (unchanged by this phase).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06r-processing-reversal-approval.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the SHP requirement block of docs/SRS.md and FR-DEL-001 (nothing else from the SRS),
docs/data-model/shp.md and del.md, the SHP and DEL cards in docs/MODULE_BOUNDARIES.md, and ADR-0011, ADR-0019,
ADR-0020, ADR-0021, ADR-0026 (the online-store assignment and the delivery split) and SA-13 in docs/ASSUMPTIONS.md.
Use docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money, hakorem-stock, hakorem-pricing and
hakorem-security-review (the public cart and checkout).
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued 2 only, on branch b07c-storefront-checkout, branched from main: the public catalogue
and product page with availability levels and no cost (FR-SHP-001, FR-SHP-002), the cart with server-computed totals
and prices re-resolved by MDM's PricingService, coupons through Promotions (FR-SHP-003, FR-SHP-004), and checkout
reservation through INV's Reservations only (serializable, all lines or none, the 15-minute release by the expiry
job releasing exactly what it reserved, FR-SHP-005, FR-SHP-006), the catch-weight estimate and maximum (FR-SHP-007),
the zone fee (FR-SHP-008), and, as the ADR-0026 delivery split decides, the del.delivery_slot table and slot
generation, with checkout storing a chosen slot through its foreign key but not enforcing capacity (capacity and
cut-offs are B11). A live animal cannot be added to a cart (422 REQUEST_TO_BUY_ONLY). A cart line in a unit other
than the product's base unit converts through MasterDataRefs.toBaseIn, never with a factor of its own. Order
placement and online payment are B09a. Write the reservation, money and permission tests first; extend the seed.
CR-019, server-side sort (owner, 2026-11-15): build the shared sort mechanism once, here, because the
storefront catalogue needs sorting by price and name anyway: an allow-list of sort fields per list (any other
field is 400), each backed by an index, and the cursor carrying the sort key and the id as a tie-breaker, so
pages never skip or repeat a row even when values tie or rows arrive between pages (prove it with a test that
pages through ties and concurrent inserts). Apply it to the storefront catalogue, then to the console lists of
products, stock on hand, lots and movements. If those four console lists make the phase too big, put them in a
small phase right after this one, still before B8, and say so.
Stop at the gate, write docs/sessions/B07c-storefront-checkout.md, and merge into main when every run on the pull
request is green.
```
