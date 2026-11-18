# B09b continued 3: the till PIN, the PIN-witnessed drop, offline overrides by PIN and the pack's units

Date: 2026-11-18 · Branch `b09b4-pos-till-pin`, from `main` (`c3c115a`) · Lane A · Status: **gate passed, no split.** The next lane A phase is **B09b continued 3b** (late cash on a closed shift, negative stock offline and the mobile money clearing account), inserted by the owner's decisions of 2026-11-18 before B09b continued 4.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

One row, A-280, lettered, and one dated amendment. A-278 (e), A-278 (f) and A-279 (f) stay **Open**, each now pointing to B09b continued 3b, which builds the owner's rulings that replace them; nothing here says the owner accepted them.

| ID | What | Who confirms |
| --- | --- | --- |
| A-278 (h) amended | The owner's decision 3 and his clarification on prices: the price the till charged always posts, the server's price is worked out only to compare, every difference is raised, REVIEW within the cashier's limit and URGENT beyond it; beyond the limit it stands on the rules only with a supervisor's PIN verified at sync and within that supervisor's own line limit. Still no approval after the fact (BL-082). | Owner |
| A-280 (a) | No split: everything in the opener, CR-051 and the owner's decision 3 built. | Owner |
| A-280 (b) | The till derives the verifier and sends only it (ADR-0080); the server cannot check four to six digits or refuse a trivial PIN: the till does. | Owner |
| A-280 (c) | Wrong tries count per person and version, every one; a success does not wipe one; the lock lasts until the owner of the PIN sets a new one online (BL-089 for a manager's reset). A try id sent from another till is reuse, refused and raised. | Owner |
| A-280 (d) | A refused try is answered `REJECTED`, raised URGENT, not stored, so judged again if resent. | Owner |
| A-280 (e) | A sign-out is recorded only once the server holds the cashier's newest PIN locked; it revokes no session; never by the cashier; by a supervisor whose PIN was in force at the sign-out's till time. | Owner |
| A-280 (f) | A PIN approval: a supervisor at the branch now, never the maker, the version named neither replaced nor at five wrong tries by the approval's till time; the version's set time is not compared with the till clock. | Owner |
| A-280 (g) LOUD | A drop's witness is PIN-verified or no witness, online (422 `WITNESS_PIN_*`) and at sync (`REJECTED`, recorded nowhere, raised), held by the database; older drops keep a null version. | Owner |
| A-280 (h) | The unverified tender's approver: verified by PIN, the break is REVIEW with `approvalVerified: true`; otherwise recorded, URGENT. | Owner |
| A-280 (i) | `listShiftWitnesses`: supervisors signed in at the shift's branch, never the cashier or the caller, from the drop rule's own source; a shift not OPEN lists nobody. | Owner |
| A-280 (j) | No PIN is seeded: a fixed seeded PIN would be one credential on every machine; staff set their own; tests derive throwaway PINs. | Owner |
| A-280 (k) | Offline overrides: within the cashier's limit REVIEW on the source only (not told to the till); beyond it URGENT whoever approved it, basis `SUPERVISOR_PIN` or `OUTSIDE_RULES`; out of the band always outside the rules. The till enforces a supervisor's limit from `listTillPinVerifiers`' `priceOverrideLimitPerLinePesewas`. | Owner, Accountant |
| A-280 (l) | CR-051's `uoms`: the pack's products' sale, selling and base units, in code order. | Owner |
| A-280 (m) | `policy.pinMaxWrongTries` is the owner's constant 5, not a setting. | Owner |

**Contract 2.17.0, LOUD for a witnessed drop and an offline price difference, otherwise additive.** Four new operations: `setTillPin`, `listTillPinVerifiers`, `reportTillPinEvents`, `listShiftWitnesses`. New optional fields: `CashMovementCreate.witnessPinVersion` (**required with `witnessId`**, the owner on 2026-11-18), `CashMovement.witnessPinVersion`, `UnverifiedMobileMoneyInput.approvedByPinVersion`, `OfflineSaleLine.overrideApproval` (a new schema for the sync's lines; `completeCounterSale` unchanged), `OfflinePolicy.pinMaxWrongTries`, `OfflinePack.uoms` (required in the response). **Behaviour:** every synced price difference is raised, URGENT beyond the cashier's limit (before: REVIEW, only beyond it). No field removed or retyped; no status changed. New error code `TILL_PIN_INVALID`.

**No ADR conflict stopped the work.** New ADR-0080 (Proposed). Amendments: ADR-0026 (three lines: this phase's placements, B09b continued 3b inserted, CR-052 into B09b continued 4), ADR-0027 (principle 9 as the owner set it). Migrations `0270_pos_till_pin` and `0271_iam_seed_pos_pin_permission`, to renumber at the merge slot if lane B merges first.

**Lane B's files:** none edited. ORD's `sale-posting.ts` was not touched: the override verdict is POS's, over the posted lines and ORD's existing findings. Shared modules changed additively only: IAM (`Authoriser.holdersIn`, lane A's), MDM (`MasterDataRefs.unitsIn`), PAY (`UnverifiedTenderRequest.approvalVerified`, optional), the platform's log scrubber (`pinSalt`, `pinHash` as secrets), the BIL rollback test's list (two names added), the contract.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 3 (`b09b4-pos-till-pin`, from `main`), lane A.
2. **Scope:** CR-032's PIN verifier, tries, lock and sign-out; every PIN approval checked; CR-050's witness and witnesses read; CR-051; then the owner's decision 3 and his clarification on prices, placed here mid-phase.
3. **Gate:** the PIN verifier, attempt limit and supervisor sign-out as the owner set them, and a drop witnessed only by a supervisor's PIN with a read of who is signed in at the branch, each test-first.

## Built

| Area | What |
| --- | --- |
| POS domain | `domain/till-pin.ts` (100 percent gate): `judgePinVerifier`, `pinLocked`, `wrongTriesBefore`, `pinEventAnswer`, `judgePinApproval`, `judgeSignOut`, `witnessPinRule`, `offlineOverrideVerdict`. |
| POS application | `TillPins` (`set`, `verifiers`, `report`, `approvalIn`), `PinStore` and `PgPinStore`; `Shifts.listWitnesses` and the PIN check on `recordCashMovement`; `OfflineSync` checks a queued drop's witness, an unverified tender's approver and each offline override; `OfflinePacks` adds `uoms` and `pinMaxWrongTries`. Event `pos.TillPinFlagged`. |
| POS data | `pos.till_pin`, `pos.till_pin_event`, `pos.till_sign_out` (LEDGER), `pos.cash_movement.witness_pin_version` with `pos.cash_movement_witness_pin_guard`, functions `pos.till_pin_wrong_tries` and `pos.till_pin_in_force` (migration 0270); `pos.pin.set` to the Owner, Manager and Cashier (0271). |
| Other modules | IAM `Authoriser.holdersIn`; MDM `MasterDataRefs.unitsIn`; PAY's optional `approvalVerified`. |
| Docs | ADR-0080; A-280 and the A-278 (h) amendment; BL-089, BL-080 scheduled; the changelog, API.md, OFFLINE_SYNC's as-built note, `data-model/pos.md`, the POS and IAM cards, abuse case 35 and R20, TB3, DC-43; the openers for B09b continued 3b and B09b continued 4 (CR-052). |

## The gate, proved by running it

`test/integration/pos/till-pin.integration.spec.ts` (24 tests), every figure by SQL over `pos.till_pin`, `pos.till_pin_event`, `pos.till_sign_out`, `pos.cash_movement`, the audit trail and the outbox.

- **The verifier.** Kofi's PIN is stored exactly as derived (PBKDF2-SHA256, 600,000 iterations, 16-byte salt, 32-byte hash) and answered without salt or hash; neither reaches the audit trail, the idempotency store or the outbox. Refused with `TILL_PIN_INVALID`, nothing stored: 599,999 iterations, a 15-byte salt, PBKDF2-SHA1, a 31-byte hash, a reused salt, an all-one-byte salt. The storekeeper and the accountant: 403. The database refuses each weaker verifier, another person setting it, a skipped version and any update. No operation in the contract has a field named `pin`.
- **Issue.** The cashier on an enrolled till gets their own verifier and the three supervisors', never another cashier's; audited. No device 401, another till's device 403, the storekeeper 403, another branch's cashier 403.
- **Five tries lock, once per person.** Four wrong tries on till P1: no lock. The fifth on till P2 locks, raised once (`TILL_PIN_LOCKED`, URGENT, abuse case 35, till P2). The same tries resent: `DUPLICATE`, still five, no second lock event; a try resent from the other till and an id with other content: `REJECTED` `ID_REUSED_WITH_OTHER_CONTENT`, raised. Ama's wrong tries never count against Kofi. A locked PIN is issued with no salt or hash. Unknown version `PIN_UNKNOWN`. The database refuses a try from another till's device and any change.
- **The locked cashier's sign-out.** Refused, nothing recorded, each raised URGENT: the cashier themselves (`SUPERVISOR_IS_CASHIER`), a cashier (`SUPERVISOR_NOT_SUPERVISOR`), a cashier not locked, a supervisor PIN locked, replaced or unknown. Kwabena's PIN signs Kofi out: recorded, audited, raised once (REVIEW); resent `DUPLICATE`. The database holds each rule (`ck_till_sign_out_checker`, `_supervisor`, `_locked`, `_supervisor_pin`). A new PIN clears the lock.
- **The witness.** With supervisors signed in, `listShiftWitnesses` names them, never the cashier, names only; another cashier, the storekeeper and another branch's cashier 403 and see nothing. A drop witnessed with Kwabena's PIN version 1 is recorded with it. Refused, nothing recorded: no version, a replaced version, a locked one, an unknown one, the cashier, a cashier as witness, no witness at all while one is signed in. The database refuses a witnessed drop with no version and with a locked or replaced one. With nobody signed in the read is empty and a drop goes unwitnessed.

`test/integration/pos/offline-override.integration.spec.ts` (5 tests, the owner's decision 3 and clarification), PRD-0005 at 2,000 (band 1,500 to 2,500), the cashier's limit 300 a line, the manager's 400; by SQL over the order line, the receipt and 4210: at the server price 2,000 posted, nothing raised; 1,700 (at the limit) posted 1,700, 4210 300, REVIEW, not told to the till; 1,699 with no PIN posted 1,699, 4210 301, URGENT `NO_SUPERVISOR_PIN`; 1,699 with the manager's PIN posted 1,699, URGENT on `SUPERVISOR_PIN`; outside the rules for a cashier's PIN, the cashier's own, an unknown version and 1,599 (401, beyond the manager's 400).

`offline-queue.integration.spec.ts` (now 21): a queued drop's witness with no PIN version or an unknown one `REJECTED`, raised; the OFFLINE_SYNC 9.9 sale's approval verified by the manager's PIN (`approvalVerified: true`, REVIEW); a supervisor named with no PIN version: recorded, URGENT, `PIN_NOT_SENT`. `offline-pack.integration.spec.ts`: `uoms` equal to MDM's rows for the pack's units by SQL, egg/eggs and crate/crates; `pinMaxWrongTries` 5.

## Mutations

Each applied alone to the committed source, the named spec run, the source restored (`git status` clean afterwards).

| # | Mutation | Result |
| --- | --- | --- |
| M1 | a cashier may sign themselves out (`judgeSignOut`) | red: 1 failing |
| M2 | anyone counts as a supervisor for a PIN approval | red: 1 failing (survived on the till PIN spec alone, which catches a non-supervisor earlier; red with the override spec) |
| M3 | a PIN locks at the sixth wrong try | red: 7 failing |
| M4 | a try resent is not answered `DUPLICATE` | red: 2 failing |
| M5 | the witness PIN not checked online | red: 1 failing |
| M6 | a queued drop's witness PIN not checked | red: 1 failing |
| M7 | a weaker verifier taken (iterations floor 1) | red: 1 failing |
| M8 | the witnesses read ignores ownership | red: 1 failing |
| M9 | beyond the limit with a supervisor's PIN raised REVIEW | red: 1 failing |
| M10 | an offline sale posts the server price, not the charged one | red: 4 failing |
| M11 | the unverified tender's approver not checked by PIN | red: 2 failing |

## Test first, as it honestly happened

- The domain spec `till-pin.spec.ts` was written first and seen red (the module did not exist), then green; the witness rule's test was seen red before its function. The offline override verdict's tests were appended in the same step as the function, so they were not seen red; M9 proves them.
- The application, the migration and the interface were written before the integration spec; the spec was then run and found: a sign-out by the cashier refused by the supervisor check before the checker (the guard now checks the checker first); the other branch has no shop floor (test fixed); a try resent from another till refused as reuse (kept; test corrected to resend each from its own till). The override spec first used a fixed-band egg crate, whose every difference is out of the band (test moved to PRD-0005). The fact key `approvalPin` tripped the event secret guard (`pin$`): renamed `approvalCheck`.
- The existing tests that recorded a witnessed drop now set the witness's PIN and send its version (`shift-close`, `force-close`, `cash-drop-witness`, `offline-queue`, `till.contract`), and `offline-conflicts` asserts the override flags URGENT: the LOUD change, by the owner's decision.

## The owner's decisions placed in this phase

- **A (decision 3, offline overrides), built:** the till enforces the cashier's own limit from the pack; above it a supervisor's PIN on the till, checked by the till PIN's rules, never the cashier, bounded by that supervisor's own line limit, never unlimited; at sync every difference raised, URGENT beyond the limit. A-278 (h) amended, ADR-0026 Amendments line added.
- **The clarification on prices, built and confirmed:** what the parent session found was right (the agreed price posts; a difference was raised only when it needed an approval, REVIEW; within-limit differences were not raised; nothing was URGENT). Now every difference is raised (REVIEW within the limit, URGENT beyond), the posted amount untouched; M10 proves a server-price posting turns the tests red. `syncOfflineSales`' description no longer says an approval is asked for after the fact. The animal test (weight changed between pack and sale) is written into B09b continued 4 with CR-052: a till cannot sell an animal priced by grade or weight today ("Goat has no price on this till", CR-052), so no such sale reaches sync from a real till yet.
- **B (B09b continued 3b), placed:** the opener carries late cash on a closed shift (replacing A-278 (e) and A-279 (f)), negative stock offline (replacing A-278 (f)), A-279's approval, the 422 in OFFLINE_SYNC section 10, and the unverified tender's own clearing account (an ADR-0003 amendment); ADR-0026 Amendments line added.
- **CR-052 placed in B09b continued 4** (checked on the frontend's main at `aad2c91`: "The till sells a live animal priced by grade or weight"), BL-080 marked scheduled.

## Contract requests (the frontend's `main` at `aad2c91`)

- **CR-032** (the till PIN): **answered (2.17.0).** Point 1 by `listTillPinVerifiers` and `setTillPin`; **point 2 decided (ADR-0080): the till derives the verifier from the PIN typed into it, the server stores and issues it, and no operation takes a PIN**; point 3 by the lock and `pinMaxWrongTries`; point 4 by the PIN versions on the witness, the unverified tender and the override, each checked at sync; point 5 held (the device credential and session are still the controls); point 6 answered in 2.11.0.
- **CR-050** (who can witness a drop): **part 1 answered (2.17.0)** by `listShiftWitnesses`; part 2 stands from 2.6.0. On "not asked, for the backend to weigh": the server holds a drop to the witness's PIN version (`witnessPinVersion`, required with `witnessId`); the till reports the PIN try with `reportTillPinEvents`.
- **CR-051** (the pack names its units): **answered (2.17.0)**, `OfflinePack.uoms`.
- **CR-052** (an animal priced by grade or weight in the pack): **scheduled into B09b continued 4** by the owner (low priority), not built here.
- **CR-033 points 1 and 2:** B09b continued 4. **CR-039, CR-041, CR-045 to CR-049:** lane B's, not touched. Everything else answered in earlier phases. Nothing declined.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB3, the POS device on shop wifi, and TB2 for `setTillPin`; the database.
- **Identity:** the PIN authenticates nothing on the server; the staff session and the device credential stay the controls; the verifier is PBKDF2-SHA256 at the owner's floor, refused weaker by the API and the database; a salt reused or all one byte refused; five tries lock across tills, counted on the server once per try.
- **Authorisation, deny by default in the handlers:** `pos.pin.set` (one's own only, `ck_till_pin_own`); `pos.sale.create` at the till's branch and the device credential for the verifiers and the report; `pos.cash.move` with the shift's ownership for the witnesses read. Wrong roles, another branch and another till tested. Maker and checker: a sign-out never by the cashier, a witness never the cashier or the caller, an override approver never the cashier, each in the domain and, where the repository holds such rules, the database (`ck_till_sign_out_checker`, `pos.cash_movement_guard`).
- **Input:** strict schemas (unknown fields 400), base64 bounded, versions 1 to 1,000,000, at most 500 tries and 50 sign-outs a report; parameterised SQL only.
- **Replay:** each try and sign-out once by its client id (primary key), resent `DUPLICATE`, other content refused.
- **Money paths (abuse cases 3 and 4):** no payment cleared on a device's word; an unverified tender's approval verified by PIN or URGENT; every offline price difference raised, beyond the cashier's limit URGENT, the charged price posted.
- **Logging and data:** salt and hash never in logs, audit, idempotency or outbox (tested); the scrubber treats `pinSalt` and `pinHash` as secrets; DC-43.
- **Abuse case 35 (new)** with its control and detection (`pos.TillPinFlagged`, kind `AUTHORISATION_FAILURE`); abuse cases 3, 4 and 17 reach the source as before, with the PIN verdicts in their facts. **Residual risk R20** (a short PIN brute-forced from its verifier) recorded.
- **Findings:** [accepted, recorded] R20; [accepted, recorded] a lock lasts until the owner sets a new PIN (BL-089 for a manager's reset); [accepted, recorded] `pos.pin.set` granted to the Owner, Manager and Cashier, not to no role: the till cannot be unlocked otherwise (the owner's CR-032).
- **Not applicable, with reason:** cookies, CSRF and CORS unchanged (the new writes carry the CSRF token); no upload, webhook, outbound URL or export; scans run in CI.

## Deferred

- **B09b continued 3b** (the owner's rulings on late cash, negative stock offline and the clearing account). **BL-089** a manager's PIN reset under a second person. **CR-052** and the animal test: B09b continued 4. BL-082, BL-086 to BL-088 stand.

## Tests (this machine, 2026-11-18, on the rebase onto `48c9808`)

| Layer | Result |
| --- | --- |
| Unit | 1,791 tests passed. `pos/domain/till-pin.ts` under the 100 percent gate (100 percent statements, branches, functions and lines in its own run). |
| Integration | Full suite on the rebase: 154 files, 1,912 tests passed on its first run. Before the rebase the first full run had 1 failure of 1,897, `authentication.integration.spec.ts`'s cashier grant list missing the new `pos.pin.set` (the test's expectation, fixed in `test(iam)`), and the rollback walk's list was given 0264 and 0265 (now 0270 and 0271). Nothing re-run to turn red green. |
| Contract | 50 files, 131 tests passed (the till contract test now also checks `TillPinStatus`, `TillPinVerifierList`, `TillPinReportResult` and `ShiftWitnessList`). |
| Lint (boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean. |
| End to end, setup, the image, the scans, coverage | Run in CI (below). |

## Notes for the frontend track

- **2.17.0:** at an online sign-in on an enrolled till, `setTillPin` with the verifier you derive (PBKDF2-HMAC-SHA256 over the PIN's UTF-8 bytes, 600,000 iterations, 16 random bytes of salt, 32-byte key, both base64); fetch `listTillPinVerifiers` and keep the verifiers in `local_auth`; a `locked` one has no material. Send every PIN try to `reportTillPinEvents` (at once online, before the shift's sales at sync), each with its own UUIDv7, the version, `FAILED` or `SUCCEEDED` and its purpose; and a locked cashier's sign-out with the supervisor's version.
- A drop's witness: `witnessId` with `witnessPinVersion`. `listShiftWitnesses` says whether to ask for one.
- An unverified tender's approval: `approvedByPinVersion`. An offline override beyond the cashier's limit: the line's `overrideApproval`, bounded by the supervisor's `priceOverrideLimitPerLinePesewas`.
- `OfflinePack.uoms` names every unit: say "6 eggs", "1 crate".

## CI

- **At the merge slot (taken 20:12Z):** rebased onto `48c9808` (lane B's B10 continued 2b, contract 2.16.1, migrations up to 0269); migrations renumbered `0270_pos_till_pin` and `0271_iam_seed_pos_pin_permission` (built as 0264 and 0265), the contract bumped to **2.17.0** above 2.16.1 with its changelog entry above lane B's. Conflicts resolved: the contract (regenerated), the planned version, the changelog, ADR-0026 Amendments, the drift test's operation count (652 published, 159 planned) and the authorisation walk's title, and the rollback walk's list (both lanes' migrations kept). The `docs(pos)` commit's subject still says 2.16.0, as written before the rebase; the documents say 2.17.0. No BIL function is replaced by this phase's migrations (the parent session's note on lane B's leave).
- **Head `c3a90ca` (pull request #115):** push run **44389474753** (`push`) success, every job green (lint and type check, the secret scan and dependency audit, contract, unit and integration with the coverage gate, the image, the setup script); pull request run **44389558644** (`pull_request`) success.
The runs on the head that adds this report are named in the closing message to the parent session, because a report cannot name the runs of the commit that adds it. The pull request merges only when every run on its head is green.

## Next session

B09b continued 3b, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b4-pos-till-pin.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pos.md,
inv.md and pay.md, the POS, INV, PAY and FIN cards in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md (sections 8 to
10), ADR-0002, ADR-0003, ADR-0027, ADR-0077 and ADR-0078, A-278 (e) and (f) and A-279 in docs/ASSUMPTIONS.md, and the
abuse cases 4, 7 and 17 in docs/security/THREAT_MODEL.md. Load hakorem-offline, hakorem-stock, hakorem-ledger,
hakorem-money, hakorem-migration and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it. Lane A (docs/prompts/session-openers.md, "Two lanes").

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 3b only, on branch b09b4b-pos-late-cash-negative-stock, branched from main. The owner's
decisions (2026-11-18), each test-first:
0. In the phase's first docs commit: A-279 (a) to (k) are approved by the owner, with item 1 below replacing "recorded
   nowhere" in A-279 (f) and A-278 (e); set their status. Fix docs/OFFLINE_SYNC.md section 10: a second shift opened
   offline on one till is refused with 422, as the contract says (A-279 (d)), not 409.
1. Closed-shift cash (replaces A-278 (e) and A-279 (f); never "recorded nowhere"). Cash from a sale or a cash
   movement whose shift has closed or been force-closed is recorded against the shift it happened in, by till time,
   as a late entry: it raises that shift's expected cash; the over or short is recomputed and posted as a post-close
   adjustment; it goes on the exception report's source and a supervisor reviews it; the shift is not reopened; if the
   cashier did not hand the cash in, the shift shows short by exactly that amount. Change it in the one deciding
   function, `tillTakesCash`. It must still respect ADR-0077's intent: cash never goes onto another cashier's shift or
   another shift. Record it as an ADR-0077 amendment by the owner. Test a late sale and a late drop, each with exact
   pesewas by SQL over the journal lines (the late entry, the adjustment to 6900 and the till's 1000).
2. Negative stock offline (replaces A-278 (f)). An offline sale may take a location's stock below zero, since the goods
   were physically sold; value it at the last known cost and true it up when stock arrives; flag it on the exception
   report's source and raise a count task for that product at that location. Online sales keep today's rules. INV is
   shared: changes are additive only. Exact quantities and values by SQL over the movements, the cost and the journal.
3. Unverified mobile money (replaces A-279 (h)'s Dr 1110). It is booked to a clearing account until verified with the
   provider, never straight into the wallet account 1110, the way a cheque waits in 1130, and moves to 1110 only when
   verified. 1120 is "Payment provider clearing", which holds provider-cleared receipts awaiting settlement, not an
   unverified payment, so the parent session's reading is a new clearing account; confirm it with hakorem-ledger and
   record it as an ADR-0003 amendment. Test the posting and the move to 1110 on verification, with exact pesewas.
Load hakorem-security-review and write its finding into the pull request body (abuse cases 4, 7 and 17).
Stop at the gate and write docs/sessions/B09b4b-pos-late-cash-negative-stock.md.
```
