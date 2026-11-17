# ADR-0074: No identifier is a key, and every customer link carries its own random token

- **Status:** Accepted (owner, 2026-11-17: decision 5 of the B09q opener; B09q continued built it). Supersedes the tracking token of ADR-0070 (its "Tracking" rule only; the rest of ADR-0070 stands).
- **Date:** 2026-11-17
- **Session:** B09q continued
- **Deciders:** owner; backend track built it

## Context

The owner's decision 5 (2026-11-17): "No ID is ever a key: every read is authorised, whatever identifier it is given. Any link sent to a customer (order tracking, the receipt, a document link) carries its own long random token. Test that knowing someone's public ID, SKU or UUID gets you nothing, per operation that takes one, as an anonymous caller and as another customer." SC-02 and ADR-0017 already require the handler to authorise with branch, location and owner; ADR-0035 requires a test that the wrong role is refused. What was missing was proof per operation that holds for every identifier a caller might know (a UUID seen in a URL, a customer's or supplier's public ID from ADR-0073, a SKU on a label), and a tracking link that is not the order's id.

ADR-0070 made the tracking token `trk_` and base64url of the order id's 16 bytes followed by a 128-bit HMAC under a key derived from the lookup key. It is unguessable, but it is the order id in plain sight, it can never be revoked or expire one link at a time, and every link of every order falls if the lookup key leaks or rotates.

## Options considered

1. **Keep the HMAC token.** Nothing stored; but the token carries the id, never expires, and depends on one long-lived key.
2. **A random token per link, stored as its hash.** 256 bits from the secure source, the SHA-256 stored with an expiry; the link is found by the hash. Costs one row per link and a lookup.
3. **A random token stored in clear.** As option 2 but a database reader could open every order's progress.

For the proof:

1. **A hand-written test per operation.** Several hundred tests that drift as operations are added.
2. **A walk generated from the contract over the mounted routes,** each operation called by the callers who must get nothing, with a real and a made-up identifier, and a list of operations that take none that must match exactly.

## Decision

Option 2 for the token, option 2 for the proof.

**Customer links (`src/platform/crypto/link-tokens.ts`, 100 percent gate).**
- `issueLinkToken(prefix)`: the prefix (two to eight lower-case letters and `_`) and base64url of `LINK_TOKEN_BYTES` (32) bytes from `randomBytes`, so 256 bits, never derived from an id or a key. Answers the token, to hand out once, and `hash`, its SHA-256, the only thing stored.
- `linkTokenHash(prefix, text)`: the hash to look up by, or null for text that is not written exactly as a token of that prefix. A lookup is by the hash under a unique index, so its time does not depend on how close a guess is; `sameLinkTokenHash` compares in constant time.
- Every link sent to a customer follows this: the module that owns the record stores the hash with its own expiry and finds the record by it, and the token is never written to a stored idempotent answer, an audit row, an event or a log.

**The tracking link (ORD, migration 0213).**
- `ord.order_tracking_token` (LEDGER): `sales_order_id`, `token_hash` (32 bytes, unique), `recorded_at`, `expires_at` (more than nothing and at most thirty days after, A-256), `actor_id`; only an ONLINE order has one (`ck_order_tracking_token_online`); never updated, deleted or truncated.
- `OnlineOrders.placeIn` issues the token (`trk_`) in the placement's transaction. `trackOrder` reads the order whose live token has that hash; anything else is 404 `NOT_FOUND`, the same for a token of the old form, a guess, an altered, expired or another order's token and the order id.
- `Checkouts.place` keeps no token in the placement's stored idempotent answer; a replay with the same key is answered with a fresh token for the same order (`reissueTrackingIn`), and the first stays valid.
- The contract's shape is unchanged (2.0.1: descriptions and the example).

**Links still to come follow the same rule.**
- **B9b's receipt link (CR-033 points 1 and 2)** carries an `rcp_` token: the till draws 32 bytes from the device's secure source (Web Crypto `getRandomValues`) when the sale is made, offline if need be, shows and prints the link, and sends the token with the sale at sync over the device's authenticated channel; the server stores only its hash (with the sale, in POS) and an expiry, and the public receipt is read by that hash. The link is never the sale's client id (a UUIDv7 is time-ordered, not secret).
- **A link sent by message (B11's tracking SMS, CR-033 point 3's receipt SMS, any send of a billing document)** is a link of its own: the outbox row names the record and never carries a token, and the worker that sends the message asks the owning module for a fresh token (as `OnlineOrders.reissueTrackingIn` does for a tracking link) in its own transaction just before the provider call, so no token is ever stored in clear, not even in the outbox. A message that is sent again gets another token.

**The proof (`test/integration/iam/no-id-is-a-key.integration.spec.ts`).** Every mounted route is read from the committed contract; each that takes an identifier (a path parameter, a uuid or `q` in its query, a uuid in its body) is called over the seeded farm by an anonymous caller, a signed-in customer and a Dodowa role lacking its permission, with a real record's identifier and a made-up one: the answer is a refusal (401, 403 or 404 as SC-02 says), the error envelope only, identical for both. The Owner of another branch is refused every operation on a record that belongs to Dodowa and sees no Dodowa row on any staff list, except master data (MDM) and `listGrants`, farm-wide by their documented rules (A-257). A customer's own read answers another customer's record 404, the guest's cart and checkout open only with the guest's cookie, and an unlisted product reads nothing by slug, id or SKU. The routes that take no identifier are listed and must match, so a new operation cannot escape.

## Consequences

- A tracking link can expire and is useless outside its order; a database reader cannot open one; rotating the lookup key no longer breaks links.
- Tracking links issued before 2.0.1 read nothing (nothing is deployed, A-256).
- The walk found FIN reading a branch's journal entry, manual journal, fixed asset and depreciation run by id, and listing them, at every branch: now read only at the record's branch (A-258 for what stays farm-wide).
- Forbidden: a customer link made from an id, a sequence or a keyed hash of either; storing a link's token in clear anywhere; an operation that takes an identifier and is not walked.
- Binds `docs/data-model/ord.md`, `docs/API.md` (ORD and SHP), `docs/security/THREAT_MODEL.md` TB1, the ORD card of `docs/MODULE_BOUNDARIES.md`, B9b (the receipt link) and B11 (the SMS links).

## Verification

- `src/platform/crypto/link-tokens.spec.ts`: 32 bytes drawn and written after the prefix, the hash its SHA-256, two tokens distinct, a short source and a bad prefix refused, only the exact spelling hashes, constant-time compare.
- `test/integration/ord/online-orders.integration.spec.ts` (trackOrder): only the hash stored with its thirty-day expiry; the token in no stored answer, audit row, outbox payload or order row; not built from the order id; a guessed, altered, old-form or id-shaped token or another order's reads nothing; a replay's fresh token and the first both read; expiry; the database's rules by direct SQL.
- `test/integration/iam/no-id-is-a-key.integration.spec.ts`, and the FIN branch tests in `manual-journals` and `depreciation-runs`.
- Mutation runs in the B09q continued report: removing a permission check, a branch check, an owner check, the guest token check or a list's branch filter, and deriving, keeping or never expiring the token, each turned the tests red.

## Amendments

- **2026-11-17, owner (CR-033, the receipt link, for B9b).** The receipt link never uses the sale's UUID, which would make it a key. The till generates the link's token offline, from a cryptographically secure generator, **at least 128 random bits** (this ADR's `rcp_` token draws 32 bytes, 256 bits, which meets it), base64url encoded, and sends it with the sale at sync. The server stores **only its hash, unique**, **valid for 12 months** from the sale's occurred time, and **revocable** (a revoked token reads nothing, like an expired one). The public receipt read takes **the token and nothing else**. Tests B9b must add: a sale's UUID, its document number or a SKU opens no receipt; a token already bound to one sale and sent again with a second sale is refused at sync (the second sale is still recorded, A-200 and the shared brief: a synced sale is always recorded; only its link is refused, and the refusal reaches the exception report's source). Who may revoke, and how a revoked receipt is reissued, is B9b's to propose, the most conservative choice recorded as an assumption.
- **2026-11-17, owner (a reused receipt token).** Approved: a token sent again with a second sale refuses only that sale's link; the sale is recorded. A 128-bit token cannot repeat by chance, so every reuse reaches the exception report as a possible till fault or tampering. That sale gets a fresh server-made token, sent by SMS (B11's receipt SMS), under this ADR's rule for links sent by message: the worker issues it just before the provider call, and it is never stored in clear. The refused till token still opens nothing.
