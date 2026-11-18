# ADR-0080: The till derives the PIN verifier, the server stores and issues it and counts every try, and no operation takes a PIN

- **Status:** Proposed (2026-11-18)
- **Date:** 2026-11-18
- **Session:** B09b continued 3
- **Deciders:** backend track; owner approves

## Context

CR-032 (made a firm request by the owner on 2026-11-16, its rules set on 2026-11-17): an offline till unlocks with the cashier's PIN, and takes a supervisor's approval offline (an unverified mobile money tender, OFFLINE_SYNC 5.3) and a cash drop's witness (the owner on 2026-11-18, CR-050) by that supervisor's PIN. CR-032 point 2 asks the backend to decide where the verifier comes from: an operation that sets a till PIN and the salted verifier the device stores, or a statement that the device derives it from the PIN typed at an online sign-in. The owner's rules, which the frontend already enforces on the device and the server must match:

- the verifier is PBKDF2-SHA256 with at least 600,000 iterations and a random salt of at least 16 bytes per person, never weaker;
- at most five wrong tries, enforced on the server too, counted at sync for offline tries and at any online check, then locked;
- a locked cashier is signed out only by a supervisor's PIN, audited, reaching the daily exception report's source;
- the PIN never authenticates to the server and is never the only control (CR-032 points 2 and 5);
- an approval made offline names the PIN version it was checked against and is verified at sync (CR-032 point 4).

`docs/OFFLINE_SYNC.md` section 3 already says "the PIN never leaves the device", and section 5.3 that a supervisor who has not logged in on the device cannot approve. A verifier only on the device that made it cannot be checked at sync, cannot be counted across tills, and cannot be issued to the till a supervisor walks up to.

## Options considered

1. **The device derives the verifier at each online sign-in and keeps it only locally** (the opener's second alternative). Nothing on the server. The server cannot say which version an approval was checked against, cannot count wrong tries across tills, and a supervisor must have signed in on every till they might approve on. Fails points 3 and 4.
2. **The server takes the PIN at set time and derives the verifier itself.** The server could check the PIN's format and refuse a trivial one; but the PIN would cross the network and the server's process, contradicting OFFLINE_SYNC section 3, and an operation would then accept a PIN, which CR-032 point 2 rules out.
3. **The till derives the verifier from the PIN typed into it and sends only the verifier; the server checks the verifier's parameters, stores it by version, issues it to the enrolled tills of the person's branch, counts every try the tills report, and checks every PIN approval against the version it names.**

## Decision

Option 3.

- **Setting a PIN.** `setTillPin` (`PUT /pos/till-pin`, permission `pos.pin.set`, seeded to the Owner, the Manager and the Cashier, migration 0271) sets the caller's own PIN as `{algorithm, iterations, pinSalt, pinHash}`: PBKDF2 with HMAC-SHA256 over the PIN's UTF-8 bytes, 600,000 to 10,000,000 iterations, a salt of 16 to 64 bytes from the device's secure generator, a 32-byte derived key. A weaker verifier is refused with 422 `TILL_PIN_INVALID` (`judgePinVerifier`, `src/modules/pos/domain/till-pin.ts`, under the 100 percent gate), and the database refuses it again (`pos.till_pin`: `ck_till_pin_algorithm`, `ck_till_pin_iterations`, `ck_till_pin_salt`, `ck_till_pin_hash`). A salt anyone used before, or all one byte, is refused (`uq_till_pin_salt`, `PIN_SALT_NOT_RANDOM`): a till that repeats a salt has no secure generator. Each set is the next version (`ck_till_pin_version`) of one's own PIN only (`ck_till_pin_own`); the newest version replaces the older ones. Audited with the version and its cost, never the salt or the hash; the log scrubber treats `pinSalt` and `pinHash` as secrets.
- **Where it lives.** In POS, not IAM: the PIN unlocks a till and approves on it; it authenticates nothing on the server, so it is a till's local secret, not an IAM credential. IAM gains one read, `Authoriser.holdersIn` (the supervisors at a branch, signed in or not).
- **Issuing it.** `listTillPinVerifiers` (`GET /registers/{id}/pin-verifiers`, `pos.sale.create` at the till's branch, the till's device credential) answers the caller's verifier and every supervisor's at the branch (holders of `pos.shift.close.approve`), each with its version, wrong tries, lock and the person's own price override limit per line; a locked PIN carries no salt or hash. Each issue is audited with whose versions it gave.
- **Counting tries.** `reportTillPinEvents` (`POST /registers/{id}/pin-events`, `pos.sale.create`, the device credential) takes every PIN try a till made, at once online and at sync for those made offline, each once forever by its client UUIDv7 (`pos.till_pin_event`, primary key). Five `FAILED` tries against a person's version lock it on every till, wherever they were made; a success does not wipe a wrong try (A-280 (c)). The fifth is raised once (`pos.TillPinFlagged` `TILL_PIN_LOCKED`, URGENT, abuse case 35). A lock lasts until its owner sets a new PIN online (`lockedUntil: NEW_PIN_SET`): signing in with a password and session is the stronger control.
- **Signing out a locked cashier.** In the same report, `signOuts`: once the server holds the cashier's PIN locked, by a supervisor of the branch who is not that cashier, whose PIN version was in force and not locked when it was made (`judgeSignOut`), held again by `pos.till_sign_out_guard` and `ck_till_sign_out_checker`. Audited (`SIGN_OUT_LOCKED_CASHIER`) and raised (`LOCKED_CASHIER_SIGNED_OUT`, REVIEW).
- **Approvals checked at sync and online.** `TillPins.approvalIn` (`judgePinApproval`): a supervisor of the branch, not the maker, with the PIN version named, not replaced and not locked when the approval was given. Used for a drop's witness online (`recordCashMovement`'s `witnessPinVersion`, held again by `pos.cash_movement_witness_pin_guard`) and at sync, for a queued drop's witness, an unverified mobile money tender's approver (`approvedByPinVersion`) and an offline price override beyond the cashier's limit (`overrideApproval`, the owner on 2026-11-18). A named supervisor without a PIN version is no approval.
- **The PIN never authenticates.** No operation takes a PIN. The staff session and the device credential stay the server's controls: a revoked till is refused whatever PIN unlocked it (`DEVICE_REVOKED`).

## Consequences

- OFFLINE_SYNC section 3's `local_auth` store holds the verifiers the till was issued, not ones it derived at sign-in; a supervisor can approve on a till they never signed in on, which section 5.3 forbade.
- The server cannot check that a PIN is four to six digits, nor refuse a trivial one: the till does (CR-032 point 3). Residual risk R20: a PIN of four to six digits under PBKDF2 at 600,000 iterations can be brute-forced from its verifier by a determined attacker with a GPU in minutes to hours, so the verifier is issued only to an enrolled, unrevoked till of the person's branch with a staff session, every issue is audited, and a PIN unlocks nothing on the server.
- A till must report its tries before the sales and movements whose approvals depend on them, or an approval made after a lock it has not reported is verified as unlocked.
- Binds: `docs/OFFLINE_SYNC.md` sections 3, 5.3 and 10, `docs/data-model/pos.md`, the POS card, abuse cases 3, 4, 17 and 35.

## Verification

- `src/modules/pos/domain/till-pin.spec.ts`: the parameters exactly, a verifier at the floor taken and one below refused for each rule, the lock at five, the approval and sign-out judgements, the offline override verdict.
- `test/integration/pos/till-pin.integration.spec.ts`: the verifier stored as derived and never answered or leaked; weaker verifiers refused by the API and the database; wrong roles refused; issue to an enrolled till only; four tries no lock, the fifth on another till locks, raised once; the same tries resent are duplicates and the count stays five; per person; a locked PIN issued with no material; the sign-out's refusals and the database's checks; a drop witnessed only by a PIN version in force; `listShiftWitnesses` naming only the supervisors signed in, refusing another cashier and another branch.
- `test/integration/pos/offline-queue.integration.spec.ts` (the queued drop's witness and the unverified tender's approver) and `offline-override.integration.spec.ts` (offline overrides).
