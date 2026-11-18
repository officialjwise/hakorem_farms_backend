# B09b continued 2b: offline sync

Date: 2026-11-18 · Branch `b09b3b-pos-offline-sync`, from `main` (`5dd1b52`, rebased onto `7ef2851` after lane B's B10 merged) · Lane A · Pull request #110 · Status: **gate passed; the phase split after its gate (A-278 (a)).** The queue's shift opens and cash movements, and the unverified mobile money tender, are **B09b continued 2c**, inserted before B09b continued 3.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

One row, A-278, lettered. Three readings are **LOUD** for the owner: (e), (f) and (h).

| ID | What | Who confirms |
| --- | --- | --- |
| A-278 (a) | The split, after the gate: a shift opened offline, the batch's cash movements (answered `REJECTED` `CASH_MOVEMENT_NOT_TAKEN_AT_SYNC` meanwhile) and the unverified mobile money tender recorded `UNVERIFIED` with its break go to B09b continued 2c. | Owner |
| A-278 (b) | "Posted late" lives in `pos.sale_sync`, not `ord.sales_order` (no ORD migration; accepted by the parent session). | Owner |
| A-278 (c) | `sync.max_sale_age_hours`: default 8, bounds 1 to 8, farm-wide, in the catalogue, not seeded. Older is recorded and flagged `OFFLINE_SALE_TOO_OLD`. | Owner |
| A-278 (d) | A synced receipt: issued at the till's `occurred_at`, dated that day or (period locked) the date FIN posts it on, levies as of then, numbers in that date's year, `synced_from_offline` true. | Owner, Accountant |
| A-278 (e) **LOUD** | Cash from the queue goes only onto its own OPEN shift. For a closed, closing or force-closed shift the sale and receipt are recorded, **no cash is recorded on any shift**, the receipt stays outstanding, and `OFFLINE_CASH_NOT_TAKEN` (URGENT) carries the cash claimed. ADR-0077 wins over ADR-0027 principle 2, as the opener directs; one function decides it (`tillTakesCash`). Accepted by the parent session as the conservative reading; put to the owner. | Owner, Accountant |
| A-278 (f) **LOUD** | Stock goes below zero only where the location allows it. The seeded shop floor does not, so a line beyond the stock there is recorded with **no movement** and a `NEGATIVE_STOCK` exception (UAT 6.13 expects "minus 3 crates"). The trigger's companion `RESERVATION_CONFLICT` is reported as raised. BL-083, BL-084, BL-085. | Owner |
| A-278 (g) | A refusal becomes its exception by rule: sold, gone or in transit `SERIAL_CONFLICT` (URGENT); a hold or an expired lot `HOLD_CONFLICT` (URGENT for a withdrawal hold); reserved `RESERVATION_CONFLICT`. `details` is `{claim, fact}`. | Owner |
| A-278 (h) **LOUD** | A price beyond the limits, out of the band or no longer priced is recorded at the agreed price (variance on 4210; an out-of-band line's floor or ceiling stretched to it, the server's band in the finding; an unpriced line `MANUAL_APPROVED` as its own band) and raised on the report, **with no approval asked for**: ORD's rule and handler (lane B) do not allow an approval waiting on a completed order. BL-082. | Owner, Accountant |
| A-278 (i) | Synced prices are tax-inclusive, as the counter's are (A-274 (g)). | Accountant |
| A-278 (j) | A printed reference other than the shift and counter make is kept in `pos.sale_sync`, not on the receipt, and raises `PROVISIONAL_REF_MISMATCH`. | Owner |
| A-278 (k) | Integrity refuses only: not a UUIDv7, a hash mismatch, an id or a counter applied to other content, a sale the catalogue cannot read. The id's time window is a flag, not a refusal (the owner on A-273 (g), recorded in ADR-0013's Amendments). | Owner |
| A-278 (l) | Who syncs: the shift's cashier, or a `pos.shift.force_close` holder with step-up; a revoked cashier's sales synced by a manager raise `AUTHORISATION_FAILURE`. | Owner |
| A-278 (m) | Gaps over every received counter; `last_device_counter` raised while not CLOSED; each newly missing value raised once. | Owner |
| A-278 (n) | Only a live cash method allowed offline is recorded at sync; any other raises `UNMATCHED_PAYMENT`; tenders not summing to the receipt raise `TENDERS_DIFFER`. | Owner |
| A-278 (o) | The order is placed and completed at `occurred_at`. | Owner |
| A-278 (p) | The exception report's source is three POS events in the outbox; the till's result lists every finding but a locked-period late posting. | Owner |
| A-278 (q) | At most 500 sales a batch, judged after authorisation; 5 MiB bodies on `/v1/pos/sync` only. | Owner |

**Contract 2.13.0, additive.** `syncOfflineSales` moves into code (476 operations in code, 170 planned, 646 in all); `BillingDocument.syncedFromOffline` is new and optional. No existing field, parameter or status of an implemented operation changed. The planned examples, which disagreed with one another, were corrected.

**No ADR conflict stopped the work.** No new ADR: the readings are A-278. ADR-0013 gains an Amendments note (the owner's A-273 (g) decision turns its "id outside the window is rejected" verification line into "recorded and flagged"); ADR-0027 gains an Amendments note naming the three LOUD readings and the tests that prove it; ADR-0026 Amendments records the split. Where ADR-0027 principle 2 and ADR-0077 meet, the opener directed ADR-0077; the parent session accepted the reading and is putting it to the owner.

**Lane B's files:** two ORD changes by the parent session's leave, each in its own commit: `NewOrderLine.stockExceptionId` and its column in `insertLines` (`c13f3be`, kept beside lane B's `quote_line_ref` on the rebase), and `SalePosting.postOfflineIn` with its exported types (`3d49a5e`). No other ORD, WHL, QUO, SHP, DEL, NTF or CST file was edited. Shared modules changed additively only: INV, FIN, BIL, AUD, platform's body limit, the contract.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 2b (`b09b3b-pos-offline-sync`, from `main`), lane A.
2. **Scope:** `syncOfflineSales` and `pos.sale_sync` with every item of the opener; split after the gate for the queue's shift opens, its cash movements and the unverified tender.
3. **Gate:** 500 queued offline transactions sync exactly once, ADR-0027's five conflict tests pass, and nothing in sync refuses a sale that passes authentication and integrity.

## Built

| Area | What |
| --- | --- |
| POS | `OfflineSync` (`syncOfflineSales`), the pure rules in `domain/offline-sync.ts` (100 percent gate), `pos.sale_sync` (migration 0256), `TillStore`'s sync reads and writes, the events `pos.OfflineSaleFlagged`, `pos.OfflineSaleRejected`, `pos.DeviceCounterGap`, `SyncBatchTooLargeError`, the route and its schema (the sale kept as sent, for its hash). POS imports FIN. |
| ORD (leave) | `SalePosting.postOfflineIn`; `plan` and `precheck` take an offline mode; `NewOrderLine.stockExceptionId`. |
| INV | `Stock.postOfflineIssueIn` and `raiseConflictIn` (savepoint, exception in a refused movement's place). |
| BIL | `Billing.issueIn` with `syncedOffline`; `bil.billing_document.synced_from_offline` (migration 0257). |
| FIN | `Ledger.postingDateIn`. |
| AUD | `sync.max_sale_age_hours` in the catalogue. |
| Platform | A 5 MiB body on `/v1/pos/sync`. |
| Docs | A-278, BL-082 to BL-085, the changelog, API.md, the POS, BIL, INV, FIN and ORD cards, `data-model/pos.md` and `bil.md`, OFFLINE_SYNC's as-built note, abuse cases 4, 10 and 11, ADR-0013, ADR-0026 and ADR-0027 Amendments, the B09b continued 2c opener. |

## The gate, proved by running it

**500 sales exactly once (`test/integration/pos/offline-sync-500.integration.spec.ts`).** The till makes 500 cash sales over eight hours with no request to the server, 10 crates (6,000) and 490 single eggs (220), and sends them shuffled in one batch. By SQL:
- 500 results, `APPLIED`, in counter order 1 to 500, no gap. 500 offline orders, 500 synced receipts, 500 payments, 500 movements, 1,500 journal entries and 2,500 numbers (an order, a receipt and three journals a sale) more than before; no stock exception.
- Order numbers and receipt numbers: 500 each, distinct, a dense span of 500, ascending with the device counter.
- Cash on the shift 167,800 (= 10 x 6,000 + 490 x 220); 4020 -167,800, the till's 1000 +167,800, 1200 0.
- 790 eggs left the shop as `SALE_ISSUE_OFFLINE`; on hand 900 to 110; the pool gave up exactly what 5020 debits and 1330 credits, and what the movements carry.
- Sent again whole: 500 `DUPLICATE` with the first numbers, and every count unchanged.

**ADR-0027's five conflict tests**, each with exact figures by SQL:
1. **An animal sold elsewhere** (`offline-conflicts`): G-0142 sold at the counter while the offline sale of it was queued. Recorded `APPLIED_WITH_EXCEPTION` `SERIAL_CONFLICT`; the line has no movement and names the exception (`claim` the till's counter, reference, time and tag; `fact` G-0142 `SOLD`); G-0142 moved once, by the counter sale; the cash on the shift, 4000 credited and 1200 settled, 5000 nil; URGENT with abuse case 11.
2. **An animal on hold**: a quarantine on G-0143 before the offline sale's time. `HOLD_CONFLICT`, no movement, the goat ACTIVE in its pen, the cash recorded, REVIEW.
3. **Countable stock gone negative**, twice: at a stall that may go below zero, six cabbages leave -6 with the movement and its `NEGATIVE_STOCK` (and the trigger's `RESERVATION_CONFLICT`), cost of sales exactly the movement's value; at the seeded shop floor, which may not, 31 crates are recorded with no movement and a `NEGATIVE_STOCK` of 930 eggs, the stock stays 900, the money is recorded (A-278 (f)).
4. **A sale in a locked period** (`offline-late-sale`): two crates sold at 21:25 on a month's last day, the month locked by the accountant, synced the next day. Recorded; `posted_late_reason` `PERIOD_LOCKED`; every journal on the sync date; the receipt issued at the till's time and dated the sync date; both numbers in that year; 1000 +12,000, 4020 -12,000, 1200 0; `OFFLINE_LATE_POSTING` REVIEW on the report, not told to the till.
5. **A missing device counter**: counters 2 to 7 and 9 → `counterGaps [8]`, `last_device_counter` 9, `DEVICE_COUNTER_GAP` raised once, URGENT, abuse case 10. In `offline-sync`, counter 7 missing is answered on every sync until it arrives and raised once.

**Nothing in sync refuses a sale that passes authentication and integrity**, each recorded with its money and its exception: a till clock at 301 seconds ahead of the server and 301 before its shift opened (300 either way is not flagged); a sale 8 hours and 1 second old (8 hours is not); a crate of cabbage, a unit it is not sold by (24 heads moved, recorded at the agreed 9,000); a mobile money tender (not recorded, the receipt outstanding, URGENT); a cashier whose grant was revoked while offline, synced by the manager (attributed to her, URGENT); sales queued on a shift force-closed meanwhile, before and after the close (no cash on any shift, each receipt outstanding by its gross, the later one URGENT); a price beyond the limit (two cabbages at 900 of 1,000) and below a fixed band (a crate at 5,800 of 6,000), each variance on 4210.

**Integrity refuses and records nothing** (counts of orders, payments, movements, documents, journals, numbers and stock exceptions unchanged): a payload edited after its hash (kept as evidence in the audit and `pos.OfflineSaleRejected` with both hashes; the honest sale then applies under the same counter), a UUIDv4 id, an id applied before with other content, a counter another sale holds. The database refuses a second applied row for a sale or a counter (`uq_sale_sync_applied`, `uq_sale_sync_counter`) and any update (`HK001`).

**Exactly once under concurrency:** two requests carrying the same sale at once: one `APPLIED`, one `DUPLICATE`, one order, one payment, one receipt.

**Wrong callers refused, recording nothing:** the storekeeper and the accountant (403), no session (401), another cashier with no force close (403), an unknown or missing credential (401 `DEVICE_CREDENTIAL_INVALID`), a revoked device (403 `DEVICE_REVOKED`), another till's device and a body naming another device (403), a shift that names nothing (404, the envelope only), 501 sales (400 `SYNC_BATCH_TOO_LARGE`), the revoked cashier herself (403). The route walks (`authorisation`, `no-id-is-a-key`) include the operation.

**CR-038 at sync:** two crates, three single eggs and a crate named by no unit at their own entries, 3 x 6,000 + 3 x 220 = 18,660, 93 eggs issued, the receipt issued at the till's time and read back `syncedFromOffline` with its provisional reference.

**UAT scenario 6 as a dry run** (`offline-sync-500`, second describe; differences below).

## Mutation checks

Each applied alone to the committed source, the three specs run, the source restored from git (`git status` clean afterwards). Every mutation that turns a conflict into a refusal (M1 to M4, M6 to M8, M12, M15) turns at least one test red.

| # | Mutation | Result (offline-sync, offline-conflicts and offline-late-sale run, 22 tests) |
| --- | --- | --- |
| M1 | a serial refusal is not an exception (rethrown: the sale refused) | red: 1 failing |
| M2 | a hold refusal is not an exception | red: 1 failing |
| M3 | negative stock refused, not excepted | red: 2 failing |
| M4 | any stock exception turns the sale into a refusal | red: 5 failing |
| M5 | a closed shift takes the cash | red: 1 failing |
| M6 | a price beyond the limit is refused (approval required on the line) | red: 2 failing |
| M7 | a line no list prices is a quote (refused) | red: 1 failing |
| M8 | a sale with no tender taken refused (NO_TENDERS) | red: 2 failing |
| M9 | the payload hash is not checked | red: 1 failing |
| M10 | the duplicate is not recognised | red: 4 failing |
| M11 | the till clock is never flagged | red: 1 failing |
| M12 | a till clock outside the tolerance refuses the sale | red: 1 failing |
| M13 | an old sale is never flagged | red: 2 failing |
| M14 | the receipt issued at the sync time | red: 2 failing |
| M15 | a locked period refuses the sale (no first open date) | red: 1 failing |
| M16 | counter gaps never answered | red: 3 failing |
| M17 | a revoked grant not raised | red: 1 failing |
| M18 | an unknown unit not flagged | red: 1 failing |

## Test first, as it honestly happened

- The domain rules' unit spec was written first and seen red (the module did not exist), then green (16, later 18).
- The setting's unit test was written first and seen red (1 of 6).
- The four integration specs were written after most of the application code existed but before it had run once. Their first runs were red on real faults, each fixed in the code, never by weakening an assertion: the shift's version not moved by the counter update (500), a sale with no tender taken refused as `NO_TENDERS`, ORD's rule refusing a completed order with an approval waiting (which led to A-278 (h)), the till's tenders compared after the cash a closed shift does not take was removed (a false `TENDERS_DIFFER`). Test corrections, each because the test was wrong: an insert-only refusal is `HK001`, a second applied counter is `23505` on `uq_sale_sync_counter`, the seeded prices begin at the seed's instant (the shifts now open 20 minutes later), number allocations are five a sale, the companion `RESERVATION_CONFLICT`, a day-old locked-period sale is also too old.

## Contract requests (the frontend's `main` at `81525f1`)

- **CR-031 point 2** (`SyncResultItem.grossPesewas` and `currency`): built; the total the server recorded, null for a refused sale, the first total on a duplicate.
- **CR-038 at sync:** built (re-priced in its own unit; a unit not sold recorded and flagged, never refused).
- **CR-032** (the till PIN) and **CR-050** (the drop witness): B09b continued 3, as placed. **CR-033 points 1 and 2:** B09b continued 4.
- **CR-039 to CR-049:** lane B's; not touched. Everything else answered in earlier phases. Nothing declined.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB3, the POS device on shop wifi (the queue a device sends), and the database.
- **SC-01 input:** strict schemas; the sale kept exactly as sent so its hash is recomputed; `payloadHash` 64 hex; unknown fields 400; at most 500 sales (2,000 parsed), 5 MiB on this route only.
- **SC-02 authorisation:** in the handler, deny by default: `pos.sale.create` at the till's branch and location for the shift's cashier, and `pos.shift.force_close` (step-up) for anyone else; the device credential after it, of the shift's till, naming itself. Every sale is attributed to the shift's cashier; a grant revoked while offline is raised URGENT. Wrong roles, anonymous, revoked and foreign devices are refused, tested.
- **Replay and tampering:** exactly once by the client id, held by the database's partial unique indexes and the document registry; a resend is `DUPLICATE`; an edited payload, a reused id or counter is refused and kept as evidence (the submission and both hashes) in the audit and the outbox. The hash detects a casual edit, not a determined device (OFFLINE_SYNC 4.4); the controls that do not trust the device hold: the server re-prices every line, the counter reveals a removed sale, cash only, the blind close.
- **SC-03, SC-04:** parameterised SQL only.
- **SC-05 money:** pesewas as bigint through `Money`; no device total trusted (the receipt is the server's; a difference is `TENDERS_DIFFER`).
- **Money paths:** no payment recorded on the device's word: only cash is recorded, and only onto its own open shift (ADR-0077, PAY's till check and trigger still apply); mobile money and card are not recorded (abuse case 4).
- **SC-07, SC-08 logging:** the rejected sale's audit and event carry the submission, which has no secret (a customer phone, if present, is the till's own field); no credential is logged.
- **SC-22, SC-23:** `pos.sale_sync` is LEDGER, insert only, grants by class; the BIL column is frozen with its document.
- **Rate limit:** the `console` group.
- **Abuse cases:** 4 (cash only at sync), 10 (counter gaps and integrity refusals raised URGENT), 11 (stock conflicts raised with claim and fact), 17 (a sale after a force close URGENT, cash not taken on a closed shift); the threat model rows 4, 10 and 11 are updated. The exception sources are the three POS events; B12 projects them.
- **Findings:** [accepted, recorded] no approval after the fact for an offline override (BL-082, lane B's ORD); [accepted, recorded] the seeded shop floor cannot go below zero (BL-083).
- **Not applicable, with reason:** SC-09 to SC-11 (cookies, CSRF and CORS unchanged; the route takes the CSRF token), SC-12 (no upload), SC-13 (no webhook), SC-14 (no external call), SC-17 (no maker-checker change), SC-19 (no outbound URL), SC-20 and SC-21 (run by the CI scans).

## UAT scenario 6, dry run: differences

- **6.13 and 6.14:** "Eggs show as minus 3 crates": with the seeded shop floor not allowing negative stock, the three egg sales beyond the stock are recorded with no movement and a `NEGATIVE_STOCK` each, and the eggs show as 0 crates until resolved (A-278 (f), BL-083). In the dry run, ten yam sales beyond the forty on hand behaved so.
- **6.13:** "Four exceptions": where a location does allow it, each egg sale below zero raises two (`NEGATIVE_STOCK` and the trigger's `RESERVATION_CONFLICT`, BL-085).
- **6.8 to 6.10:** the interrupted sync (20 sent, then all 50, then all 50 again) gives 50 orders and 50 consecutive receipts, 70 duplicates logged: as the scenario expects.
- **6.7:** a goat at GHS 700.00 more than 10 percent below list is refused by the device; were it to arrive, the server records it with its variance and raises `PRICE_OVERRIDE` with no approval (A-278 (h)).
- **Setup:** the seed has 30 crates of eggs (900 eggs) at the shop and its goats in the pens, not 40 crates and G-0206 to G-0209 in PEN-G3; the UAT figures are illustrative for this seed.
- **6.16:** a closed shift is not reached in the scenario; were T1 force-closed before its sync, its cash would not be recorded (A-278 (e)).

## Deferred

- **B09b continued 2c:** a shift opened offline; the batch's cash movements; the unverified mobile money tender with its break.
- **BL-082:** an approval after the fact for an offline price (lane B's ORD). **BL-083:** the shop floor allowing negative stock. **BL-084:** moving what stands and excepting the shortfall. **BL-085:** the companion reservation conflict.

## Tests (this machine, 2026-11-18)

| Layer | Result |
| --- | --- |
| Unit | 144 files, 1,699 tests passed. The new domain file is under a 100 percent gate (44 statements, 21 branches, 15 functions, all covered). |
| Integration | Full suite: 149 files, 1,827 of 1,830 passed on its first run. The three failures were test lists that name every migration or every operation and did not yet name the new ones: `archive-link-rollback` (the rollback order, now with 0257 and 0256, which also proves both roll back), and the two route walks, `authorisation` and `no-id-is-a-key` (the operation's valid body was added to `test/support/routes.ts` while the run was going). Those three files then passed (28 tests). Nothing was re-run to turn red into green. The new specs: offline-sync 14, offline-conflicts 7, offline-late-sale 1, offline-sync-500 3. ORD and QUO's existing specs passed unchanged after the ORD store change (`sale-posting`, `orders`, `quotes`: 35 and 38 tests). |
| Contract | 48 files, 129 tests passed, with the new till contract test (`OfflineSyncResult`, `BillingDocument` with `syncedFromOffline`, the refusals). |
| Lint (boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate` | Clean. |
| End to end, setup, the image, the scans, coverage | Run in CI. |

## Notes for the frontend track

- **2.13.0:** `syncOfflineSales` is live. Send a batch per shift with the device credential and the CSRF token, no `Idempotency-Key`. Store each result's `orderNo`, `receiptNo` and `grossPesewas`; compare `grossPesewas` with the till's total. Show `exceptions` to the cashier; none of them means the sale was lost.
- `REJECTED_INTEGRITY` means nothing was recorded: keep the record red, never retry it automatically.
- `counterGaps` is answered on every sync until the sale arrives.
- A cash movement in a batch is answered `REJECTED` `CASH_MOVEMENT_NOT_TAKEN_AT_SYNC` until B09b continued 2c: record it online with `recordCashMovement`. A shift opened offline must still be opened online within the clock tolerance until then.
- `BillingDocument.syncedFromOffline` marks a receipt of a synced sale; `issuedAt` is the till's time.

## CI

- **Main before the rebase:** `7ef2851` (lane B's B10, contract 2.12.0). This branch was rebased onto it once; the one conflict, lane B's `quote_line_ref` beside this phase's `stock_exception_id` in `insertLines`, kept both, with the parent session's leave.
- **The code and docs head, `32d2ee2` (pull request #110): green.** Push run **44319649827** (`push`) and pull_request run **44319733590** (`pull_request`, which compares the contract with `main`), both `success`. No run was re-run.
- The runs on the head that adds this report are named in the closing message to the parent session, because a report cannot name the runs of the commit that adds it. The pull request merges only when every run on its head is green.

## Next session

B09b continued 2c, copied from `docs/prompts/session-openers.md` (added by this phase's split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b3b-pos-offline-sync.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, docs/data-model/pay.md, the POS and PAY cards in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md
(sections 5.3, 6, 9.9 and 10), ADR-0027, ADR-0077, A-274, A-277 and A-278 in docs/ASSUMPTIONS.md, and the abuse cases 4,
10 and 17 in docs/security/THREAT_MODEL.md. Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it. Lane A (docs/prompts/session-openers.md, "Two lanes").

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 2c only, on branch b09b3c-pos-offline-queue, branched from main, each test-first:
1. A shift opened offline (OFFLINE_SYNC 10, BL-078): `openShift` from the queue with the client shift id and the
   till's `openedAt` hours old, from an enrolled device of the till; applied once by its id, its shift sequence
   confirmed by the server; a till time outside the tolerance recorded and flagged, never refused (the owner on A-273
   (g)); two devices opening on one till offline: the second refused at sync as OFFLINE_SYNC 10 says.
2. The cash movements of a sync batch (`cashMovementResults`, OFFLINE_SYNC 10): each applied exactly once by its client
   id onto its own shift while open (ADR-0077: never onto another shift; a closed or force-closed shift's movement
   recorded nowhere and raised, as A-278 (e) does for a sale's cash), at the till's `occurredAt` though it is hours old,
   answered APPLIED, DUPLICATE or REJECTED with its reason; replace B09b continued 2b's interim answer
   `CASH_MOVEMENT_NOT_TAKEN_AT_SYNC`. A drop's witness offline is B09b continued 3's (the PIN).
3. The unverified mobile money tender (OFFLINE_SYNC 5.3 and 9.9, abuse case 4): only while
   `pos.offline.allow_unverified_mobile_money` is on for the branch, a tender with `unverifiedMobileMoney` is recorded as
   an `UNVERIFIED` payment through PAY (shared, additively) on its own open shift, allocated to the receipt, with an
   `UNVERIFIED_PAYMENT` reconciliation break (REVIEW; URGENT if the method was not permitted offline) and
   `pay.unverified_window_days`; with the setting off it stays as B09b continued 2b built it (not recorded,
   `UNMATCHED_PAYMENT`). The supervisor's PIN approval is B09b continued 3's; record who the till says approved it.
Load hakorem-security-review and write its finding into the pull request body.
Stop at the gate and write docs/sessions/B09b3c-pos-offline-queue.md.
```
