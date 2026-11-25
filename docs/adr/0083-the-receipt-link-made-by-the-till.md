# ADR-0083: The receipt link, made by the till, stored as its hash

- **Status:** Accepted (owner, 2026-11-17: CR-033 as amended in F10e and ADR-0074's two Amendments; B09b continued 4 built it, the reading of each open point recorded as A-284).
- **Date:** 2026-11-23
- **Session:** B09b continued 4 (lane A)
- **Deciders:** owner; backend track built it

## Context

The owner's rule of 2026-11-16: every sale produces a digital receipt, by SMS or a link, and a printer is optional. ADR-0074 made every customer link a random token stored as its hash, and its Amendments set the receipt link's terms: the till makes the token offline (at least 128 random bits from a secure generator, base64url), sends it with the sale at sync, and the server stores only its hash, unique, valid for twelve months and revocable. The public read takes the token and nothing else. A token already bound to one sale and sent again with a second sale refuses only that sale's link: the sale is recorded, the reuse reaches the exception report as a possible till fault or tampering, and the sale is marked as needing a fresh server-made link (B11's receipt SMS). No QR code (owner, 2026-11-17). The frontend's request (CR-033, F10e shape) names `OfflinePack.receiptLinkTemplate`, `OfflineSale.receiptToken` (`^[A-Za-z0-9_-]{22,86}$`) and `GET /shop/receipts/{token}`.

Three things were still open: the token's exact form (ADR-0074 wrote `rcp_` and 32 bytes; CR-033 asks for 16 bytes and no prefix), where the receipt's tenders and change come from (the server never stored what the customer handed over), and where the shop's address comes from.

## Options considered

1. **The server checks the token's form strictly** (`rcp_` and 43 characters, as `linkTokenHash`). The till's 22-character token of CR-033 would be refused and the frontend's shape broken.
2. **The token is opaque text of the frontend's form**, 22 to 86 base64url characters, hashed exactly as written. It accepts any token of at least 128 bits written in that alphabet (a `rcp_` token among them). The server cannot measure randomness, so it can only refuse what is plainly not random: a UUID.
3. **The server makes the token at sync.** Then no link exists offline, so the till cannot print it. Refused by the owner.

For tenders and change: read PAY's payments (the server's record, but it has no tendered amount and leaves out a tender not taken), or keep the till's tenders with the link (what the customer handed over, as the paper receipt shows).

## Decision

Option 2, with the till's tenders kept with the link.

- **`OfflineSale.receiptToken`** (optional, covered by `payloadHash`): 22 to 86 base64url characters. A batch with a malformed one is 400 as any malformed field. `pos.receipt_link` (LEDGER) stores the SHA-256 (`uq_receipt_link_token`), one link per sale (`uq_receipt_link_sale`), the sale's time and `expires_at` exactly twelve months later in UTC (`ck_receipt_link_expiry`, computed by the database), the till's tenders and the change worked out by `changeDue`. The link is written in the sale's own serializable transaction after its `pos.sale_sync` row (`ck_receipt_link_synced`), so a link exists only for an applied sale.
- **A refusal never refuses the sale.** `receiptTokenVerdict` (100 percent gate): a UUID-shaped token is `TOKEN_IS_AN_IDENTIFIER`; one bound to another sale is `TOKEN_ALREADY_BOUND`. `pos.receipt_token_refusal` (LEDGER, primary key the refused sale) holds it once, with `needs_server_link` always true, and `ck_receipt_token_refusal_bound` proves the named sale holds that hash. The sale's result says `RECEIPT_TOKEN_REFUSED`, and ◆ `pos.OfflineSaleFlagged` raises it URGENT with abuse case 37, naming the device, the shift, the cashier and both sales. A replayed sync is a `DUPLICATE` and adds nothing. Two concurrent sales with one token meet the unique index, and the second is retried and refused.
- **`getPublicReceipt`** (`GET /v1/shop/receipts/{token}`, public, `rateLimit: 'public'`): the hash of a token of the till's form, a live link (not expired, not revoked at the read's instant from the application clock). Anything else is 404 `NOT_FOUND` with one message. The answer is the order number, the official receipt number, the lines as charged (ORD's order view), the total (BIL's receipt), the till's tenders with their method names and the change, and the shop's name, phone and address (AUD's `BusinessProfiles.shopProfile`, CR-028), with no id of anything.
- **`OfflinePack.receiptLinkTemplate`** is `<RECEIPT_LINK_BASE_URL>/r/{token}` from configuration (https only), null while it is unset, so a farm without the shop's address configured makes no links and syncs as before.
- **The token is never written** to a stored answer, an audit row, an event or a log. A sale refused for integrity carries `receiptLinkSent` in its evidence in place of the token. The event publisher refuses any field named like a token.
- **Revocation:** `pos.receipt_link_revocation` (LEDGER, once per link, with a reason). A revoked link reads nothing. The operation that writes it, and who may call it, are in B09b continued 4b (A-284 (f)).

## Consequences

- A receipt link works offline on paper and on screen, and from the sale's first sync for a year. A database reader cannot open one, and nothing a customer knows about the sale (its id, numbers, SKU, provisional reference) opens it.
- A till that reuses a token, by fault or on purpose, loses only that sale's link and is on the exception report each time.
- The receipt's tenders are the till's claim. Where they differ from what the server recorded, the sale already carries `TENDERS_DIFFER` (URGENT).
- Forbidden: a receipt read by anything but the token; storing a receipt token in clear; a link for a sale that was not applied.
- Binds `docs/data-model/pos.md`, `docs/OFFLINE_SYNC.md`, `docs/security/THREAT_MODEL.md` (abuse case 37), `docs/API.md` (POS), the POS card, B09b continued 4b (revocation) and B11 (the receipt SMS and the fresh link for a refused sale).

## Amendments

- **2026-11-23, B09b continued 4b (A-285 (b)): the revoke is built.** `revokeReceiptLink`: a holder of `pos.shift.close.approve` at the sale's branch, with its step-up, revokes a sale's link with a reason, once and audited; the link then reads nothing, answered exactly as a guessed token. The database holds who may (`ck_receipt_link_revocation_supervisor`, migration 0297). Tested in `test/integration/pos/receipt-link-revoke.integration.spec.ts`, the wrong role refused. The decision above is unchanged.
- **2026-11-25, B12 continued 5 (BL-133; the owner's decision of 2026-11-24, A-396; the parent session's leave in POS, A-398): a live sale's till also makes its link.** `completeCounterSale` takes `CounterSale.receiptToken` (2.51.0, optional, `OfflineSale.receiptToken`'s form and validation). In the sale's own transaction, after it is posted, the token is judged and recorded through `ReceiptLinks.judgeIn` and `recordIn`, the synced sale's own path: its SHA-256 bound to the sale as its one `TILL` link (issued at the server's time, the tenders as taken, the change by `changeDue`), or its refusal recorded once (`TOKEN_ALREADY_BOUND`, `TOKEN_IS_AN_IDENTIFIER`) and raised as `pos.CounterSaleFlagged` `RECEIPT_TOKEN_REFUSED` (URGENT, abuse case 37), which the daily exception report reads as a synced sale's refusal. A refused token never refuses the sale; a replay of the key writes nothing. Without the token the sale is unchanged. Migration 0377 widens `ck_receipt_link_synced` and `ck_receipt_token_refusal_synced` (expand only) to admit a live sale's own row and nothing else: a registered document other than the shift that no sync ever logged, on an `OPEN` shift, written by that shift's cashier, a link issued at its recording time. Every other rule here stands. Tested in `test/integration/pos/live-receipt-link.integration.spec.ts`.

## Verification

- `src/modules/pos/domain/receipt-link.spec.ts` (100 percent gate): the form, the hash, each verdict and the template.
- `test/integration/pos/receipt-link.integration.spec.ts`: exact pesewas by SQL and through the read; only the hash stored, the token nowhere; twelve months; 404 for a guess, an altered token, the sale id with and without hyphens, its order and receipt numbers, a SKU, the provisional reference, a short or padded token, a prefixed one and the hash; a reused token refused once per sale and raised once, a replay adding nothing, a third sale refused against the first; the sale id as a token refused; a sale refused for integrity binding nothing; revoked and expired links; the public rate limit; the database's rules.
- `test/integration/iam/no-id-is-a-key.integration.spec.ts` lists `getPublicReceipt` among the public operations proved in their module.
