# B09b continued 4: the receipt link

Date: 2026-11-23 · Branch `b09b5-pos-receipts`, from `main` (`204e95b`) · Lane A · Status: **phase split at its sub-domain boundary (A-284 (a)). The receipt link is built and its gate passed locally.** The business buyer's TIN, the invoice paid at the till, CR-052 and the link's revoke operation move unchanged to **B09b continued 4b**, before B09c.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-284 (a) | **Split:** this phase builds the receipt link only. The rest of its opener moves unchanged to B09b continued 4b, before B09c (ADR-0026 Amendments): the buyer's TIN, the invoice paid at the till, CR-052 and the link's revoke operation. | Owner |
| A-284 (b) | **The token's form** is CR-033's: 22 to 86 base64url characters, hashed with SHA-256 exactly as written (an `rcp_` token fits). A token shaped like a UUID is refused (`TOKEN_IS_AN_IDENTIFIER`). A malformed token is 400 for the batch, as any malformed field. | Owner |
| A-284 (c) | **Offline sales only.** An online counter sale carries no till token; its digital receipt is B11's server-made link by SMS. | Owner |
| A-284 (d) | **Tenders and change:** the till's tenders as it took them are kept with the link, with the change `changeDue` gives (nil when its rules give none). The lines and total are the server's. | Owner |
| A-284 (e) | **What the receipt shows:** the sale reference is the order number. The business is the shop's public profile (name, phone, address; null while unset). No id of anything, and nothing of any customer. | Owner |
| A-284 (f) | **Revocation:** the table is built now, and a revoked link reads nothing. The operation is proposed for 4b: a holder of `pos.shift.close.approve` at the sale's branch, with a reason. A revoked receipt is reissued only as B11's server-made link. | Owner |
| A-284 (g) | **Every refusal is URGENT** (`RECEIPT_TOKEN_REFUSED`, abuse case 37), told to the till and raised once per refused sale. | Owner |
| A-284 (h) | **A refused sale with no customer phone:** no link is made and nothing is stored in clear. The customer keeps the till's receipt, and the counter reprints the official receipt on request with the reprint marker. B11 sends the fresh link only to a phone. | Owner |
| A-284 (i) | **The link's address** comes from `RECEIPT_LINK_BASE_URL` (https only). Unset, `receiptLinkTemplate` is null and the till makes no link. | Owner |
| A-284 (j) | **"Being recorded"** is the till's own words until sync. The server has no token before sync, so it answers 404, never a state other than `RECORDED`. | Owner |
| A-284 (k) | **Expiry:** twelve months after the sale in UTC, computed by the database. | Owner |
| A-284 (l) | **The rate limit** is the existing public group, per address. | Owner |

**For the parent session to schedule:** B09b continued 4b (inserted, its opener in `docs/prompts/session-openers.md`). CR-059 to CR-062 stay B12's, and CR-057 point 1 still needs both lanes (as the last report said).

**ADR-0083 (new):** the receipt link made by the till. **ADR conflicts: none.** ADR-0074 wrote the token as `rcp_` and 32 bytes, as an example of the rule. Its owner's Amendment sets the floor at 128 bits, and CR-033 asks for 16 bytes. ADR-0083 accepts both forms, so ADR-0074's rule (random, at least 128 bits, stored as its hash) holds unchanged.

**Contract 2.24.0, additive:** `getPublicReceipt` is new; `OfflineSale.receiptToken` (optional) and `OfflinePack.receiptLinkTemplate` (always sent, nullable) are new; a sync result may name `RECEIPT_TOKEN_REFUSED`. No existing shape changed.

**Also:** A-328 to A-331's four date cells were corrected to 2026-11-23, in a `docs:` commit of their own.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 4 (`b09b5-pos-receipts`, from `main`), lane A.
2. **Scope:** CR-033 points 1 and 2 (the receipt link and the public read), the reused token, the buyer's TIN, the invoice paid at the till and CR-052. After reading the code, the receipt link alone was a full phase, so the rest was split off before it was started (A-284 (a)).
3. **Gate:** the public receipt read by its token alone; a reused token recorded and refused once per sale (this phase). The buyer's TIN on the VAT invoice and an invoice paid at the till inside the shift moved to B09b continued 4b with CR-052.

## Built

| Area | What |
| --- | --- |
| Data, POS | `0292_pos_receipt_link`:<br>- `pos.receipt_link` (LEDGER): the hash, unique; one per sale; twelve months by the database (`ck_receipt_link_expiry`); the till's tenders and change. `pos.receipt_link_guard`: the device's till and shift, the sale applied on it.<br>- `pos.receipt_link_revocation` (LEDGER, once per link).<br>- `pos.receipt_token_refusal` (LEDGER, once per refused sale, `needs_server_link`), with its guard: the bound sale holds that hash, and the refused sale holds no link. |
| POS domain | `receipt-link.ts` (100 percent gate): the token's form and hash, `receiptTokenVerdict` (bind, keep, refuse as bound or as an identifier), the template. |
| POS application | `ReceiptLinks`:<br>- `judgeIn` and `recordIn`, in the sale's serializable transaction. The link is written after its `pos.sale_sync` row.<br>- `publicReceipt`, reading ORD's order view, BIL's receipt, MDM's methods and AUD's shop profile.<br>`OfflineSync` raises a refusal as ◆ `pos.OfflineSaleFlagged` `RECEIPT_TOKEN_REFUSED`. A rejected sale's evidence carries `receiptLinkSent`, never the token. `OfflinePacks` gives `receiptLinkTemplate`. |
| Interface | `ReceiptsController` with `getPublicReceipt` (public, `rateLimit: 'public'`); `OfflineSale.receiptToken`. The identifier walk lists it. |
| Platform (shared, additive) | `RECEIPT_LINK_BASE_URL` (https only) and `receiptLinkTemplate(config)`. |
| Docs | ADR-0083; the ADR-0026 amendment; A-284; abuse case 37; DATA_CLASSIFICATION (DC-43); the data model; the POS card; API.md; OFFLINE_SYNC 4.3 (no QR code) and 4.5; the changelog (2.24.0); the openers (the split and B09b continued 4b). |

## The gate, proved by running it

`test/integration/pos/receipt-link.integration.spec.ts` (16 tests), read by SQL and through the read:
- **The pack** carries `https://shop.hakorem.test/r/{token}`.
- **Two synced sales, read by their tokens:**
  - 2 crates at 6,000, cash 12,000 with 15,000 handed over. The receipt answers exactly: the order number, `RCP-...`, the line (2.000 CRATE, the lot `EGG-BIG-2026-1110`, 6,000, 12,000), total 12,000, cash 12,000 tendered 15,000, change 3,000, and the seeded shop's name, phone and address. No UUID anywhere in the answer.
  - The other sale's token reads only that sale (6,000, change 4,000).
- **Only the hash:**
  - The stored hash is the token's SHA-256, `expires_at` is exactly 12 months after `issued_at`, and the change is 3,000.
  - The token text is in no sync row, link row, idempotency answer, audit row, outbox payload or order.
- **One 404 for twelve wrong keys:** a guess, an altered token, the sale's UUID with and without hyphens, its order number, its receipt number, a SKU, the provisional reference, a short, padded or `rcp_`-prefixed token, and the hash itself. All answer the same `NOT_FOUND` body.
- **A replay** is `DUPLICATE`; still one link.
- **A reused token:**
  - The second sale is `APPLIED_WITH_EXCEPTION` (`RECEIPT_TOKEN_REFUSED`). Its order and its 12,000 cash are recorded, and it has no link.
  - The first token still reads the first sale.
  - The refusal row names the bound sale, the hash, `needs_server_link`, the device, the shift and the cashier.
  - Exactly one outbox entry (URGENT, abuse case 37, both sales).
  - A replayed sync adds no entry and no row. A third sale with the token is refused against the first, once.
- **The sale's own id sent as its token** is refused `TOKEN_IS_AN_IDENTIFIER`, and the id opens nothing.
- **A sale refused for integrity** binds nothing. Its evidence says `receiptLinkSent: true` and holds no token.
- **The database refuses:**
  - a second link of a hash (`uq_receipt_link_token`) or for a sale (`uq_receipt_link_sale`);
  - a wrong expiry (`ck_receipt_link_expiry`);
  - a link for a document that is not an applied sale (`ck_receipt_link_synced`);
  - a refusal against a sale that does not hold the hash (`ck_receipt_token_refusal_bound`);
  - update and delete on all three ledgers.
- **Revoked:** reads nothing.
- **Expired:** reads one millisecond before `expires_at`, and nothing at it.
- **Rate limit:** past the public limit the read answers 429.

`src/modules/pos/domain/receipt-link.spec.ts` (8 tests) was written first and seen red (the module did not exist), then green at 100 percent.

## Mutations

Each mutation was applied alone to the source, `receipt-link.integration.spec.ts` was run, and the source was restored byte for byte (compared with `cmp`).

| # | Mutation | Result |
| --- | --- | --- |
| M1 | a refused token's refusal skipped, so the second sale's link is bound anyway | red: 7 failing (the unique hash refuses the bind, so the sync fails) |
| M2 | the read without its expiry check | red: 1 failing (the expiry test) |
| M3 | the read ignoring a revocation | red: 1 failing (the revocation test) |
| M4 | the refusal not raised to the till or the source | red: 5 failing |
| M5 | `receiptTokenVerdict` without its identifier check | red: 2 failing |

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since the last report)

- **CR-033 points 1 and 2 (and item 4 of the F10e shape):** built in 2.24.0 as requested. There are three differences:
  - `receiptLinkTemplate` is nullable (null while the shop's address is not configured);
  - `PublicReceipt` adds `validUntil` and the business's `address`;
  - `business` is null while no profile is set.
- **CR-033's question** ("what does the server do with a token it already holds for another sale"): the sale is recorded and only its link is refused. The result names `RECEIPT_TOKEN_REFUSED`, and the sale waits for a server-made link (B11).
- **CR-033 point 3** (the SMS and `receiptMessage`): B11's, as the opener says.
- **CR-052:** moved with its owner's clarification to B09b continued 4b (named at the top).
- **CR-059 to CR-062:** RPT's, B12. B12 adds `RECEIPT_TOKEN_REFUSED` as a kind on the report.
- **CR-057 point 1:** both lanes, still to schedule.
- Everything else was answered in earlier phases.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB1 (the public internet, an unauthenticated read) and TB3 (the till's sync).
- **Authorisation:** `getPublicReceipt` is public by design. Its only key is the till's random token, at least 128 bits, found by its hash under a unique index. Nothing else opens it: the walk lists it, and the spec proves the sale id, the numbers, a SKU and the provisional reference all fail. Binding happens only inside `syncOfflineSales`, which keeps its authorisation: the shift's cashier, or a manager recovering it, on the enrolled device of the shift's till. The database refuses a link for any sale not applied on that device's shift.
- **No other customer's data:** the answer carries no id, no customer name or phone and no cost. A business buyer's name and TIN (4b) must not be added to it without a decision.
- **One answer:** every miss is the same 404 body, and the lookup is by hash, so its time does not depend on how close a guess is.
- **Rate limit:** the public group per address, tested to 429.
- **Secrets:** the token is never stored, logged or published. The event publisher refuses a key named like a token, and the rejected sale's evidence replaces it with `receiptLinkSent`. The hashes are DC-43 (Restricted).
- **New abuse case 37** (a guessed, forged or reused link): `RECEIPT_TOKEN_REFUSED` is URGENT on the exception report's source once per refused sale.
- **Database:** three LEDGER tables, insert-only (tested), each with a guard. The grants schema test covers them.
- **Findings:**
  - [accepted, recorded] the server cannot test a token's randomness, only its length and that it is not a UUID (A-284 (b));
  - [accepted, recorded] the tenders shown are the till's claim (A-284 (d)), and a difference from the server is already `TENDERS_DIFFER`;
  - [deferred, scheduled] the revoke operation (4b, A-284 (f));
  - [deferred, scheduled] the fresh link for a refused sale (B11).
- **Not applicable, with reason:** cookies, CSRF and CORS are unchanged (a GET with no session); there is no upload, webhook, outbound call or export.

## Deferred

B09b continued 4b (the split). B11: the receipt SMS, `receiptMessage`, and the server-made link for a refused or revoked sale. BL-100 to BL-105, BL-082 and BL-087 to BL-089 stand.

## Tests

On this machine, at `e23fc9d` (the same tree as the final code commits but for the spec's token literal, see CI). `main` had not moved from `204e95b`, so no rebase was needed and none was made.

| Layer | Result |
| --- | --- |
| Unit | 154 files, 1,834 tests passed. `src/modules/pos/domain/receipt-link.ts` is under a new 100 percent gate and met it. |
| Integration | Full suite, once, at `032358d`: 163 files, 1,991 tests, **2 failed**. Both were stale expectations, not flakes: `iam/authorisation`'s list of mounted operations (now with `getPublicReceipt`) and `bil/archive-link-rollback`'s list of migrations rolled back down to 0155 (now 0292 first, which also proves 0292's `migrate:down`). Both were fixed in their own `test:` commit, and the two files then passed (17 tests). Before that: the POS folder and the identifier walk, 22 files, 244 tests passed. The new spec has 16 tests. Nothing was re-run to turn red green. |
| Contract | 53 files, 134 tests passed (the drift count is now 654 operations, 506 in code). `contract:generate` is up to date, and Redocly is clean. |
| Lint (boundaries, fixtures, placement, schema names), typecheck | Clean. |
| End to end, setup, the image, the scans, coverage | Run in CI (below). |

## Notes for the frontend track

- **2.24.0:**
  - Fill `OfflinePack.receiptLinkTemplate` (when not null) with each sale's own token, and send the token as `OfflineSale.receiptToken`, inside the hashed sale.
  - Read the receipt with `getPublicReceipt`; anything wrong is one 404.
  - A result naming `RECEIPT_TOKEN_REFUSED` means that sale's link will not work. Tell the cashier, and print the official receipt if the customer wants one.

## CI

- **Merge slot:** taken 2026-11-23T05:53Z. `main` was still `204e95b` (lane B idle), so there was nothing to rebase or renumber: migration 0292 sits above main's 0291, and contract 2.24.0 above 2.23.0.
- **Pull request #122.**
  - **`e23fc9d`** (the first push): push run 45120582005 **failure** and pull_request run 45120617051 **failure**.
    - In both, only the job "secret scan, dependency audit, static analysis (SEC-034)" failed, at "secret scan over the whole history". Every other job was green: lint, contract, setup, the image, the three shards and the merged coverage gate.
    - **Cause, found locally:** gitleaks ran with the repository's own `.gitleaks.toml` and found 4 `generic-api-key` hits, all in `src/modules/pos/domain/receipt-link.spec.ts` lines 11, 31, 35 and 39. They were a made-up 22-character token written as a literal (`token: '...'`), which looks like a key to the scanner.
    - **Fixed in the test, not the scanner:** the spec now builds its token (`'Ab-_'.repeat(5)` plus `Cd`). No allowlist or waiver was added. Because the scan covers the whole history, the fix was squashed into the `feat(pos)` commit, and the branch was pushed with `--force-with-lease` (only this branch, inside the merge slot).
    - Locally, gitleaks over `HEAD`'s history then reports "no leaks found", and the spec passes (8 tests). Nothing was re-run.
  - **The final head** carries this report. Its runs (push and pull_request, the three shards and the merged gate among them) are named in the closing message to the parent session and on the pull request. It merges only when every one is green.

## Next session

B09b continued 4b, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b5-pos-receipts.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, ADR-0077 and its
Amendments, ADR-0083 and A-284, and the abuse cases 3, 4 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 4b only, on branch b09b5b-pos-tin-invoice-animal-price, branched from main.
The owner's addition (2) to A-200 (2026-11-16), test-first: a business buyer at the counter may have their name and TIN
printed on the VAT invoice without opening a customer account, so they can reclaim the input tax: optional buyer name
and TIN on the counter sale and the billing document, validated in format, printed on the invoice, and never creating a
customer; the walk-in party stays. BIL is shared: additive columns only (bil.document_settlement_keep,
bil.apply_settlement and bil.credit_note_refund are never edited); check docs/security/DATA_CLASSIFICATION.md for the TIN.
The owner, 2026-11-16 (A-212 (a)): cash enters only through a till shift. Build a customer paying an invoice at the till
inside the shift, counted at close, and refuse any cash payment outside an open shift, test-first: the cash goes onto
the cashier's own open shift through the existing deciding function (tillTakesCash, ADR-0077 and the owner's late-entry
amendment); no second path.
CR-052 (the owner, 2026-11-18, from the frontend's F10l; low priority, BL-080 scheduled here, A-277 (f)): the offline
pack gives each sellable animal priced by grade or weight its price, so the till can sell it: the price is resolved
by the pricing engine from that animal's own latest weight and grade, never derived; it carries the weight's date and
source; the server re-prices at sync, as every synced sale is; an animal with no weight or no grade stays priceless and
is answered as such; exact pesewas tests. The owner's clarification on prices (2026-11-18) with it: an animal whose
weight changed between the pack and the sale posts the price charged, the server's price from the latest weight is
worked out only to compare, and the difference is flagged (REVIEW within the cashier's limit, URGENT beyond it), with
exact pesewas by SQL over the order line and the journal lines.
The receipt link's revoke (ADR-0074 Amendments, A-284 (f)): a holder of pos.shift.close.approve at the sale's branch
revokes a sale's link with a reason, audited, test-first with the wrong-role refusal and the identifier walk; a
revoked link then reads nothing (pos.receipt_link_revocation is built), and its reissue is B11's server-made SMS link.
Stop at the gate and write docs/sessions/B09b5b-pos-tin-invoice-animal-price.md.
```
