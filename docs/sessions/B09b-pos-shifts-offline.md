# B9b: point of sale, the till's cash (split; continued in four parts)

Date: 2026-11-17 · Branch `b09b-pos-shifts-offline`, from `main` (`1eefa55`), with `main` merged in at `a5214fc` · Pull request [#96](https://github.com/officialjwise/hakorem_farms_backend/pull/96) · Status: **phase split (A-273 (a)); this part's gate, a shift close reconciles to the pesewa, passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-273 | **The till as built in B9b, and the split.** Eleven points, (a) to (k), listed below. | Owner (a, c, d, f, h), Accountant (e, i) |

A-273's points:
- **(a) The split.** This part built registers, shifts with the float, cash drops, pay-outs and pay-ins, the X and Z reports, and the blind close with its supervisor's sign-off and over or short. The rest is four phases, each with its own opener section between B9b and B09c:
  - **B09b continued** (`b09b2-pos-devices-counter`): device enrolment, the counter sale's endpoint (`completeCounterSale` needs the device credential the contract names), the force close and held sales.
  - **B09b continued 2** (`b09b3-pos-offline-sync`): the offline pack and sync, ADR-0027's five conflict tests, the 500-sale test (the gate's second half), and **CR-038** (the owner's scope addition: a crate or a single egg at the till, each at its own price).
  - **B09b continued 3** (`b09b4-pos-till-pin`): the till PIN (CR-032).
  - **B09b continued 4** (`b09b5-pos-receipts`): the receipt link (CR-033 points 1 and 2), the business buyer's name and TIN, and a customer paying an invoice at the till.
- **(b)** Nothing prints yet: the till's ESC/POS receipt is the counter sale's.
- **(c) Reasons by kind.** A drop needs `SAFE_DROP` (new, migration 0225), because FR-POS-016 refuses a drop without a reason. A pay-out needs `FUEL_PAYOUT`, `SUPPLIER_PAYOUT` or `OTHER_PAYOUT`. A pay-in is only float from the safe (`FLOAT_TOP_UP`), so no cash enters the books outside a sale. `BANK_DEPOSIT` and `CHANGE_PURCHASE` fit no kind and are refused.
- **(d) A drop's witness** holds `pos.shift.close.approve` at the branch and is neither the cashier nor the recorder. Online the witness is named, not signed in; the drop is checked against the safe at the sign-off. The witness's PIN is B09b continued 3.
- **(e) Postings (migration 0228):** the float Dr 1000 (the register) Cr 1010; a drop Dr 1010 Cr 1000; a pay-in Dr 1000 Cr 1010; a pay-out Dr the expense by reason (6800 by default) Cr 1000; the sign-off Cr 1000 expected, Dr 1010 declared, Dr 6900 short or Cr 6900 over. Each once per subject.
- **(f) Grants (migration 0230):** the Cashier, Manager and Owner open, move cash, declare and sell (the Owner must hold every permission of a role it grants, FR-IAM-022); only the Owner and Manager sign off, with step-up, never their own; the Owner and Manager set tills up; the Owner, Manager, Accountant and Cashier read, a cashier only their own. Cash on another cashier's shift is left to `pos.shift.force_close`, seeded with the force close.
- **(g) Times:** an online shift opens and cash moves at the application clock's time; the till's time must be within 300 seconds of it (a named constant until `sync.clock_tolerance_seconds` is seeded).
- **(h) The seeded day:** till T1, the seeded cashier's shift open on it with no float (the seeded books hold no cash in the safe to give one), every seeded sale's cash in that shift. The yams sale is on channel POS; the goat sale stays a wholesale sale at the counter so its prices and every seeded figure hold.
- **(i) Expected cash** counts the shift's CLEARED cash payments less what was refunded of them. A cash refund paid outside an open shift is not refused yet: B09b continued refuses it.
- **(j) Reports:** an X report is a reading and is not stored; the Z report is stored once at the sign-off. Price given below list counts the completed lines sold below their resolved price.
- **(k) Cash into a till names its shift** (migration 0227, `ck_payment_cash_shift`). That the shift is a SHIFT, open and the seller's own is POS's check under the shift's lock: PAY sits below POS, and the schema-names check forbids PAY's migration reading the platform's registry.

**No ADR conflict.** ADR-0026 Amendments records the split (and keeps main's F10f placements line before it); no posting rule of another module changed; FIN's catalogue gains POS's five events only.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B9b (`b09b-pos-shifts-offline`, from `main` at `1eefa55`).
2. **Scope:** the opener's whole list (registers to the receipt link), too large for one context; split after the till's cash, the first sub-domain, as "If a session cannot finish" says.
3. **Gate:** shift close reconciles, and 500 queued offline transactions sync exactly once. This part proves the first fact; the second is B09b continued 2's gate.

## Contract changes

**2.5.0, minor and additive.** The changelog entry and its cold-read line are written.
- **Twelve planned operations move into code, shapes unchanged:** `listRegisters`, `createRegister`, `updateRegister`, `listShifts`, `openShift`, `getShift`, `listShiftCashMovements`, `recordCashMovement`, `getShiftXReport`, `getShiftZReport`, `closeShift`, `approveShiftClose`.
- **Still planned:** the devices, `forceCloseShift`, held sales, `getOfflinePack`, `completeCounterSale`, `syncOfflineSales`.
- **Behaviour as built, recorded loudly:** a reason for every cash movement; a drop's witness a supervisor; `openedAt` and `occurredAt` within 300 seconds of the server's clock; expected cash null for every reader until declared; `approveShiftClose` needs step-up (`x-requires-step-up`); `Register.deviceCount` 0 until devices exist.
- **New error codes:** `REGISTER_INVALID`, `SHIFT_INVALID`, `CASH_MOVEMENT_INVALID`; the catalogue's `SHIFT_NOT_OPEN`, `SHIFT_ALREADY_OPEN` and `SHIFT_CLOSE_SAME_PERSON` are now answered. `PAYMENT_INVALID` and `SALE_INVALID` gain `SHIFT_REQUIRED`.
- **Examples:** `listPostingEventTypes` names `pos.ShiftClosed`'s four amounts.
- **Checks:** `contract:generate` (440 operations from code, 202 planned), Redocly clean, `scripts/contract/versioning.ts` against `main`: ok.

## Built

| Area | What |
| --- | --- |
| Migrations | 0224 the `SHIFT` document (numbered `SHF`); 0225 the `SAFE_DROP` reason; 0226 the `pos` schema: `register` (MASTER), `shift` (DOCUMENT, `pos.shift_guard`, `ck_shift_steps`, `ck_shift_over_short`, `ck_shift_close_checker`, one open per till and per cashier), `cash_movement` (LEDGER, `pos.cash_movement_guard`: an OPEN shift only, the cashier never the witness), `shift_tender_count` (blind, completed once), `shift_report` (LEDGER, one Z); 0227 `ck_payment_cash_shift` and its index; 0228 the five POS posting events and their rules; 0229 and 0230 the nine `pos.*` permissions and their grants. Every rollback is walked by `bil/archive-link-rollback`. |
| POS domain | `till.ts`: `expectedCash`, `overShort`, `closeAmounts`, `changeDue` (for the counter sale), `judgeCashMovement`, `judgeCountSignOff`; `client-time.ts`: the UUIDv7 and clock-tolerance checks. |
| POS application | `Registers` (list, create, update with the version), `Shifts` (open, get, list, cash movements, X and Z, close, sign-off), `PgTillStore`, the controller, the module wired in `app.module.ts`. |
| PAY | `Payments.recordIn` refuses a cash tender into a till with no shift (`SHIFT_REQUIRED`); `Payments.shiftTotalsIn` (read-only). |
| ORD | `SalePosting` posts channel POS with its `shiftDocumentId` (required on POS) and passes it to the payment; `Orders.shiftSalesIn` (read-only). |
| FIN | `tillAmounts` and the five translators. |
| Seed | Till T1 and the seeded cashier's open shift take the trading day's cash; the yams sale is on channel POS. |
| Docs | A-273, ADR-0026 Amendments, the four opener sections, `data-model/pos.md`, the POS card, `DOMAIN_MODEL` 5.11, `API.md` (section and catalogue), THREAT_MODEL abuse case 17, the changelog. |

## The gate, proved by running it (`test/integration/pos/shift-close.integration.spec.ts`, 18 tests)

**A short shift on T1.** Adwoa opens T1 with 50,000, sells 20 yams and 4 cabbages for 44,000 in cash, drops 30,000 in front of Kwabena (a manager) and counts 63,500 blind.
- **Derived independently by SQL** over `pos.cash_movement` and `pay.payment`: expected **64,000**; over the journal lines, the till's 1000 against T1 is **64,000** before the sign-off.
- **The sign-off posts** exactly 1000 Cr **64,000**, 1010 Dr **63,500**, 6900 Dr **500**. Afterwards 1000 against T1 is **0**, 6900 over the shift's journals **500**, 1010 **43,500** (−50,000 + 30,000 + 63,500), and the trial balance over every journal line sums to **0**.
- **Blind:** before the declaration `expectedCashPesewas` is null for the cashier and the manager; after it, 64,000 and short 500; the X report never shows it.
- **The X report** adds its tenders to the sales exactly (CASH 1 sale, 44,000 of 44,000), with FLOAT_IN 50,000 and CASH_DROP 30,000. The Z report is stored at the sign-off, and the database refuses changing it or the closed shift (HK004).
- **`pos.ShiftClosed`** is in the outbox once with the cashier, the supervisor, short 500 and `abuseCases: [17]`. A second sign-off is refused and posts nothing.

**An over shift on T2:** float 20,000, a fuel pay-out of 1,250 (its note required), 5,000 topped up from the safe, counted 24,000 by Nana and signed off by the Owner: expected **23,750**, over **250** to 6900 as a credit, 6800 debited **1,250**, the till back to **0**.

**Maker and checker:** the Cashier is refused the sign-off (403); a Manager who ran a shift is refused signing off their own count (422 `SHIFT_CLOSE_SAME_PERSON`) and the shift stays CLOSING; the database refuses `close_approved_by = cashier_id` (`ck_shift_close_checker`). A drop witnessed by the cashier is refused (`WITNESS_IS_MAKER`), by a storekeeper (`WITNESS_NOT_SUPERVISOR`), and in the database by the shift's own cashier (`ck_cash_movement_witness`).

**Cash only through a shift (A-212 (a)):** a POS sale with no shift is `SALE_INVALID` `SHIFT_REQUIRED`; a cash tender into a till with no shift is `PAYMENT_INVALID` `SHIFT_REQUIRED`; the database refuses such a payment (`ck_payment_cash_shift`); a cash movement on a CLOSING shift is `SHIFT_NOT_OPEN` and the database refuses it (HK010).

**Also:** one open shift per till and per cashier (422 and the partial unique index); replayed open and drop do nothing twice; a till with a shift open is not retired, a code taken is refused, a version mismatch is 409, and a retired till opens no shift.

**Wrong roles:** another cashier, a storekeeper and the accountant are refused the till's writes; another cashier and another branch's user are refused its reads; a cashier cannot create a till; a storekeeper cannot open a shift. The handler walk (`iam/authorisation`) and the identifier walk (`iam/no-id-is-a-key`) cover all twelve operations.

**The seeded day (test-first, `rpt/dashboard-sales`):** the new test that every seeded sale's cash is on the cashier's open shift at T1 was red (the seed failed with `SHIFT_REQUIRED`) before the seed changed. Today's sales by channel show POS 8,000 (one sale), ONLINE 6,000 and WHOLESALE 80,430, and the `getSalesTodayTile` and `getSalesSeries` figures are unchanged in total.

## Mutation checks (each applied alone, the shift spec run, the source restored with `git checkout`)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | The handler no longer refuses the cashier signing off their own count | red: 1 of 18 |
| 2 | The domain no longer refuses a drop witnessed by its maker | red: 1 of 18 |
| 3 | The domain no longer requires the witness to be a supervisor | red: 7 of 18 |
| 4 | Expected cash shown while the shift is OPEN | red: 2 of 18 |
| 5 | PAY no longer refuses cash into a till with no shift | red: 1 of 18 |
| 6 | `ck_shift_close_checker` removed from migration 0226 | red: 1 of 18 |
| 7 | The database guard's witness check removed from migration 0226 | red: 7 of 18 |
| 8 | Over and short swapped in the domain | red: 4 of 18, and 2 of 26 unit tests |

## Test first, as it honestly happened

- **`till.spec` (26 tests) and the FIN `tillAmounts` tests (4):** written before their code and seen red (module missing; `tillAmounts is not a function`).
- **The seeded day's shift test:** written first and seen red, as above.
- **`shift-close` integration spec:** written after the application code. Its first runs were red on real faults: the Owner could not grant roles holding the new permissions (fixed in 0230), a cashier's location-scoped grant was refused because the handlers checked the branch only (fixed: the till's location is checked), and every update missed `platform.touch_version`'s version step (fixed in the store). Mutations 1 to 8 prove it bites.
- **The first full unit and integration run was red (17 tests in 14 files):** ORD and INV tests posted cash into fake tills with no shift; the walks, the reason-code count, the cashier's permission list and the rollback walk needed the new rows. A test shift written outside the sale's serializable transaction was not in its snapshot (`fk_sales_order_shift`), so `test/support/till.ts` writes it in the sale's own transaction. Each was fixed in the code or the expectation it named; no assertion was weakened, nothing skipped.
- **The schema-names check refused** a PAY trigger that read the platform's document registry; the trigger was dropped and A-273 (k) says so.

## Decisions

- No new ADR: the split is an ADR-0026 Amendment; every choice is in A-273.
- No new port. POS imports IAM, MDM, PAY and ORD; PAY and ORD publish one read-only method each.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB2 (back office), TB3 (the POS device on shop wifi, through its staff session) and the database.
- **The standards, item by item:**
  - SC-01: strict zod bodies, amounts parsed as exact integers; unknown fields refused.
  - SC-02: authorised in every handler at the till's branch and location, deny by default; a cashier reaches only their own shifts; the wrong role, another cashier and another branch are tested.
  - SC-03 and SC-04: parameterised SQL only.
  - SC-05: kernel `Money`; no number arithmetic in a file that imports it (the lint rule holds).
  - SC-06: every write takes its idempotency key; client ids are UUIDv7.
  - SC-07 and SC-08: events and audit carry ids and pesewas only.
  - SC-14: no external call.
  - SC-15 and SC-16: no empty catch; stable codes.
  - SC-17: maker and checker apart on the sign-off (handler and `ck_shift_close_checker`) and on a drop (handler, `ck_cash_movement_witness` and the guard), mutation-checked.
  - SC-22: cash movements and the Z report are insert-only; a closed shift is frozen.
  - SC-23: serializable writes, the shift locked.
  - SC-24: open, every movement, the declaration and the sign-off are audited with before and after.
- **Not applicable, with reason:** SC-09 to SC-11 (the existing console routes and cookies); SC-12 (no upload); SC-13 (no webhook); SC-18 (no restricted field); SC-19 (no outbound URL); SC-20 and SC-21 (the CI scans).
- **Abuse:** case 17 (`SHIFT_OVER_SHORT`): its control is built and `pos.ShiftClosed` is its source, with abuse case 17, the cashier, the supervisor and the amount. B12 builds the report item. **Residual, A-273 (d):** online, a drop's witness is named rather than signed in; the supervisor's sign-off of the count is the check, and the witness's PIN is B09b continued 3.

## Deferred (each to its named part)

- B09b continued: devices, `completeCounterSale`, the per-shift override limit, the force close, held sales, a cash refund only from an open shift (A-273 (i)), the audit anchor at each sign-off.
- B09b continued 2: the pack, sync, the five conflict tests, the 500-sale test, A-200 addition (1), UAT scenario 6's dry run, the settings seed, CR-031, CR-038.
- B09b continued 3: the PIN (CR-032).
- B09b continued 4: CR-033 points 1 and 2, A-200 addition (2), an invoice paid at the till, the thermal receipt.
- UAT scenario 6 was not run: it needs the sync, B09b continued 2.

## Contract requests

The frontend's `main` was read at `439e1db` at the start and at `41ce67c` after the owner's scope addition; it holds CR-001 to CR-041.
- **CR-031 (the pack's `taxInclusive`, `SyncResultItem.grossPesewas`):** scheduled in B09b continued 2, where the pack and sync are built.
- **CR-032 (the till PIN; the pack's CASH_MOVEMENT reasons):** points 1 to 5 in B09b continued 3; point 6 in B09b continued 2. The CASH_MOVEMENT reasons the pack will carry are now fixed by kind (A-273 (c)).
- **CR-033 points 1 and 2 (the receipt link):** B09b continued 4. Point 3 stays B11's.
- **CR-038 (a crate or a single egg at the till, the owner's scope addition):** B09b continued 2, with the offline pack and sync, as the parent asked; its opener carries the owner's paragraph.
- **CR-039, CR-040, CR-041:** placed by the owner in B11, B09c and B10; not touched here.
- **Everything else:** answered in earlier phases.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit and integration, merged (`pnpm test:coverage`) | **3,216 passed**, 261 files. Statements 94.19 percent, branches 84.45 (the gate is 80), functions 97.69, lines 96.87. **The first merged run was red** on one 100 percent gate: `src/modules/fin/domain` at 99.5 percent of branches (two fallbacks in `tillAmounts` never taken). Fixed in `cbbd289` (a close that leaves an amount out is refused, the test written first and seen red); the FIN domain then reads 100 percent of statements, branches, functions and lines (180 tests). The merged figures after the fix are CI's (below). |
| Contract (`pnpm test:contract`) | **120 passed**, 46 files, including the new `b9/till`. **The first full run was red** on `api/openapi-drift` (the planned count) and `b3/slice-and-login` (no route schema for the till's request examples); fixed in `a8b02fd`. |
| Lint (module boundaries, lint fixtures, test placement, schema names), typecheck, Redocly, `contract:generate`, versioning against `main` | Clean. The schema-names check was red once on a PAY trigger reading the platform's registry; the trigger was dropped (A-273 (k)). |
| End to end, setup, the image, the scans, the last migration rolled back and applied again | Run in CI. |

Nothing was re-run to turn red into green. Each red run above was a real gap, fixed in its own commit or before the first commit of its code, and the next run is a new run on the fixed code.

## Gate

**This part's gate passed:** a shift close reconciles to the pesewa, proved by SQL over the journal lines, independent of the handler, with maker and checker apart and mutation-checked. **The phase gate's second fact** (500 queued offline transactions sync exactly once) is B09b continued 2's.

## Notes for the frontend track

- **2.5.0 is additive.** The shift screens can use the twelve operations now; the counter sale and the offline queue still run against the mock.
- **Reasons:** a drop sends `reasonCode: SAFE_DROP` and a supervisor's `witnessId`; a pay-out its expense reason and the note the reason requires; a pay-in `FLOAT_TOP_UP`.
- **Blind close:** `expectedCashPesewas` is null until `closeShift`; then the answer carries it. `approveShiftClose` needs a step-up.
- **Times:** send `openedAt` and `occurredAt` as now; the server records its own time.

## CI

- **`a8b02fd`** (the code head first pushed, pull request #96): run **44183282580 (push)** **failed** on the coverage gate (`src/modules/fin/domain` at 99.5 percent of branches, the same red as the local run); run **44183350750 (pull_request)** was **cancelled** by the next push. Nothing was re-run.
- **`cbbd289`** (the fix, the code and docs head): run **44184517441 (push)** **succeeded**, and run **44184526178 (pull_request)** **succeeded**. Its jobs: lint and type check; unit and integration with the coverage gate (**3,217 passed**; statements 94.18, branches 84.45, functions 97.69, lines 96.87; every 100 percent gate held); contract; the setup script with end to end, smoke and the last migration rolled back and applied again; the image build and scan; the secret scan, the dependency audit (the owner's live waiver only) and static analysis.
- **This report's own commit:** its runs are named in the session's closing message, because a report cannot name the runs of the commit that adds it. The pull request merges only when every run on its head is green.

## Next session

B09b continued, copied from `docs/prompts/session-openers.md` (written by this split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b-pos-shifts-offline.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0016 (the device credential), ADR-0027, A-273 in docs/ASSUMPTIONS.md, and the abuse cases 1, 3, 4 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued only, on branch b09b2-pos-devices-counter, branched from main: device enrolment
(enrolDevice, listRegisterDevices, revokeDevice: a credential shown once and stored hashed, revocable, Register.deviceCount
true); completeCounterSale (POST /pos/sales, x-owner-module ord) through ORD's SalePosting.postIn on the seller's own
OPEN shift locked for the sale, with the device credential the contract names, change from cash only (the domain's
changeDue), the per-shift price override limit (FR-POS-004), a mobile money or card tender only as a payment already
initiated and cleared by the provider (FR-POS-006), and the refusal of any cash outside an open shift, test-first;
forceCloseShift (a manager, a reason, the shift closed at its expected cash, audited, seeding pos.shift.force_close,
the variance posted when the drawer is counted later); held sales (holdSale, listHeldSales, recallHeldSale, re-priced on
recall, lapsing at close); a cash refund paid only out of an open shift of the till that took the payment (A-273 (i));
the audit chain anchored at each sign-off through the worker. Every write gets its wrong-role refusal test; every new
read joins the identifier walk. Maker and checker never the same user, mutation-checked.
Stop at the gate and write docs/sessions/B09b2-pos-devices-counter.md.
```
