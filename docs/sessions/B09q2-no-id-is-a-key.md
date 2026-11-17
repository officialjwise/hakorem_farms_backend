# B09q continued: no identifier is a key, and every customer link has its own random token

Date: 2026-11-17 · Branch `b09q2-no-id-is-a-key`, from `main` (`edec540`) · Pull request #86 · Status: **gate passed**. B09e runs next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-256 | **The tracking token as built.** It is 256 random bits (`trk_` and 43 base64url characters). Only its SHA-256 is stored, in `ord.order_tracking_token`. The link reads its order for **thirty days**, and the database caps it there too. A replay of `placeOrder` answers a fresh token and the first stays valid. Links of the old signed form read nothing (nothing is deployed). | Owner |
| A-257 | **What stays farm-wide for staff outside a record's branch.** MDM master data (locations, delivery zones and the rest of the reference data) and `listGrants`, each by its documented rule. Every other branch record is refused at another branch, by id and in lists. | Owner |
| A-258 | **FIN's records follow the branch; its statements do not.** Journal entries, manual journals, fixed assets and depreciation runs are read only where a whole-branch grant holds the read permission. The trial balance, profit and loss, balance sheet, cash flow and account activity stay farm-wide aggregates, as B08 built them. | Owner, Accountant |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-204, A-206, A-207, A-209, A-211, A-213, A-214, A-216 to A-240, A-242 to A-258.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09q continued (`b09q2-no-id-is-a-key`, from `main` at `edec540`).
2. **Scope:** the owner's decision 5 of 2026-11-17:
   - a refusal test generated per operation that takes an identifier, run as an anonymous caller, as another customer, as a staff role without the permission and as staff outside the record's branch, with the refusals mutation-checked;
   - trackOrder's HMAC token replaced by a random token stored only as its hash, with an ADR superseding that part of ADR-0070;
   - contract 2.0.x, with descriptions and examples changed only.
3. **Gate:** as the opener states it.

## Contract changes

**2.0.1, patch.** No field, parameter, schema or status changed.
- Descriptions changed on `trackOrder` (plus its `token` parameter), on `placeOrder` (the replay's fresh token) and on `PlaceOrderResult.trackingToken`.
- One example changed: the `placeOrder` token, now `trk_EXAMPLE-tracking-link-not-a-real-token-0001`.
- Behaviour, same shapes: FIN's four branch records are read only at their branch (A-258). The changelog entry and the cold-read line say so.
- `contract:generate --check` is up to date (422 operations from code, 214 planned). Redocly is clean. `scripts/contract/versioning.ts` against `main` prints `contract versioning: ok`.

## Built

| Area | What |
| --- | --- |
| Platform | `src/platform/crypto/link-tokens.ts` (100 percent gate). `issueLinkToken(prefix)` draws 32 bytes from `randomBytes` and returns the token and its SHA-256. `linkTokenHash` returns the hash of an exactly-spelt token, or null. `sameLinkTokenHash` compares in constant time. |
| Migration 0213 | `ord.order_tracking_token` (LEDGER): a 32-byte unique hash, `recorded_at`, and an expiry that must be after issue and at most 30 days later. A trigger allows online orders only. The table rejects update, delete and truncate. Rollback tested (the 0155 rollback walk includes it). |
| ORD | `TrackingTokens.issueIn` / `orderOfIn` look a token up by its hash at the application's clock (ADR-0067). `OnlineOrders.placeIn` issues the token. `reissueTrackingIn` serves a replay. `OnlineOrders` no longer takes the lookup key. |
| SHP | `Checkouts.place` stores its idempotent answer without the token, and answers a replay with a fresh one. |
| FIN (fix found by the walk) | `getJournalEntry`, `getManualJournal`, `getFixedAsset` and `getDepreciationRun` authorise again at the record's branch. Their four lists filter to `readableBranches` (`fin/application/read-scope.ts`). |
| Tests | `test/support/routes.ts` (the handler walk's routes, bodies and queries, now shared). `test/integration/iam/no-id-is-a-key.integration.spec.ts` (11 tests, below). The trackOrder block of `ord/online-orders` (7 tests). FIN branch tests in `manual-journals` and `depreciation-runs`. The link-token unit spec (7 tests). |
| Docs | ADR-0074 (indexed; ADR-0070's status line and its Tracking rule marked superseded). A-256 to A-258. The changelog. `docs/data-model/ord.md`. The ORD card. `docs/API.md` section 4 (no identifier is a key; customer links) and ORD. The threat model's TB1 rows. B9b's and B11's openers now read ADR-0074. |

## The gate, proved by running it

**Knowing an identifier gets you nothing, per operation that takes one.** The walk is generated: every mounted route is looked up in the committed contract.

- **What counts as taking an identifier:** a path parameter, a uuid or `q` query parameter, or a request body that reaches a uuid. That covers 343 staff operations, 17 public ones and `getMyOrder`.
- **No escape for new operations:** the 61 operations that take none are listed, and the list must match exactly.
- **The three refused callers:** an anonymous caller, a signed-in customer, and a Dodowa role that lacks the permission (a seeded role, chosen from the contract's `x-seeded-roles`; 250 or more of the operations use one, the rest a user with no grant).
  - Each caller calls with a real record's id and with a made-up one.
  - There are 51 real ids, from the seeded farm with its trading day plus a stock take, hold, health event, feed record, draft processing order and file made at Dodowa. Each customer and supplier search uses a real public ID, and each product search a real SKU.
  - Every answer is 401, 403 or 404 as SC-02 says. It carries the error envelope only (no details, no identifier echoed), and the real and made-up answers are identical.
- **Staff outside the record's branch:** the Owner of another branch is refused every operation on each Dodowa record that belongs to Dodowa (403 or 404, nothing in the answer), and sees no Dodowa row on any staff list. Exempt by documented rule (A-257): `getLocation`, `updateLocation`, `archiveLocation`, `getDeliveryZone`, `updateDeliveryZone` (MDM) and `listGrants`. The test pins that exact list.
- **A customer's own read:** `getMyOrder` answers another customer's order 404, exactly as it answers a made-up id. Anonymous and staff callers get 401.
- **The storefront:**
  - Another guest, or a caller with no cookie, gets 404 on all ten cart and checkout routes, real and made-up alike.
  - An unlisted product reads nothing by its id or SKU (400, the same as a made-up one of that form, since neither is a slug) and is in no catalogue search.
  - `validateCoupon` answers the same for any customer id.
  - `trackOrder` and `receivePaymentWebhook` are proved in their own modules.

**Every customer link carries its own long random token, stored only as a hash, never derived from an id** (`ord/online-orders`, trackOrder block):
- The stored row is the token's SHA-256, and its expiry is 30 days after issue.
- The token text is in no stored idempotent answer, audit row, outbox payload or order row.
- It contains neither the order id's bytes nor the old id-and-MAC form.
- Two orders' tokens differ. A guessed token, an altered one (in the middle or at the end), the old form, `trk_<id>`, the id, `trk_` and the bare body each read nothing (404, envelope only).
- A replay's fresh token reads the order, and so does the first.
- At the expiry instant the token reads nothing; one millisecond before, it does.
- The database refuses a short hash, a duplicate, 31 days, 0 days and a counter (non-online) order. Update and delete are refused for `hk_app` (42501) and the owner role (HK001).

**The link B9b's receipt and B11's SMS must follow** (ADR-0074, "Links still to come"):
- **B9b's receipt link** carries an `rcp_` token: 32 bytes from the till's Web Crypto `getRandomValues` when the sale is made (so it works offline), sent with the sale at sync. The server stores only the hash and an expiry. It is never the sale's client id.
- **A link sent by message** (B11's tracking SMS, CR-033 point 3's receipt SMS, a document send) is its own link. The outbox row names the record, never a token. The sending worker asks the owning module for a fresh token (as `OnlineOrders.reissueTrackingIn` does) just before the provider call, so no token is ever stored in clear.

**No shape of 2.0.0 changed.** Contract 2.0.1 changes descriptions and one example, with its changelog entry.

## Mutation checks (each applied alone, the targeted tests run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 0 | `getOrder` without its permission check | red: the role without the permission got 404 for a made-up id and 403 for a real one |
| 1 | `getOrder` without its branch check | red: the Owner of another branch read the order |
| 2 | A stock take read without its branch and location | red (branch walk) |
| 3 | `getJournalEntry` without this phase's branch check | red (branch walk) |
| 4 | Journal entries listed at every branch | red (list walk) |
| 5 | `getMyOrder` without its owner check | red (customer's own read) |
| 6 | A cart opened without the guest's token | red (storefront) |
| 7 | The tracking token built from the order id | red (3 tests) |
| 8 | No expiry on the token lookup | red (expiry) |
| 9 | The token kept in the stored idempotent answer | red (stored nowhere else) |

## Test first, as it honestly happened

- **Red before code:** the link-token unit spec (no module); the trackOrder block, where 5 of 7 failed before migration 0213 and the new ORD code; the FIN leak, which the walk found first. With FIN unchanged, the walk logged `getJournalEntry`, `getManualJournal`, `getFixedAsset`, `listJournalEntries`, `listManualJournals` and `listFixedAssets` answering Dodowa's records to another branch's Owner. The FIN branch tests in `manual-journals` and `depreciation-runs` were written after the fix and proved by mutations 3 and 4.
- **The walk's own iterations:** its first run showed what had to be classified, not code to change:
  - `validateCoupon` was public and unlisted;
  - delivery zones and locations are MDM master data, read farm-wide;
  - `listGrants` is farm-wide by API.md;
  - customers hold no file permission (403, not 401, on the two file routes).
- **CI red, fixed in its cause:** run 44078351987 (push, on `6d3c612`) failed only its secret scan. The 2.0.1 example token was a freshly drawn random value, which gitleaks flags as a generic key. Commit `fix(shp)` replaces it with a plainly labelled example and allows both literals in `.gitleaks.toml` (the random one stays in history; no system issued it). I confirmed it locally with the pinned gitleaks image over the whole history ("no leaks found"). Nothing was re-run, skipped or quarantined.

## Decisions

- ADR-0074, accepted by the owner's decision 5. It supersedes ADR-0070's tracking token only.
- Customer links: a 256-bit random token behind a prefix, stored only as its SHA-256, with an expiry, looked up by hash. A link sent by message gets its own token from the sending worker.
- FIN reads follow ADR-0017 rule 2 (A-258).

## Security review (hakorem-security-review)

- **Boundaries:** TB1 (storefront: tracking, carts, catalogue) and TB2 (back office: every staff read by id).
- **Standards, item by item:**
  - SC-01: every walked body is schema-valid, so a refusal is the permission's.
  - SC-02: the walk; FIN fixed.
  - SC-03/04: parameterised SQL; `ANY($n::uuid[])`.
  - SC-05: no money touched.
  - SC-06: the replay answers the same order with a fresh token.
  - SC-07/08: tokens come from `randomBytes`. Only hashes are stored. No token in logs, audit, outbox or idempotency (tested).
  - SC-11: `trackOrder` keeps the `public` rate limit.
  - SC-15/16: refusals carry the envelope only (tested).
  - SC-22/23: the new table is LEDGER, insert-only by trigger, written in the placement's serializable transaction.
  - Not applicable, nothing changed there: cookies, CORS, uploads, webhooks, payments, encryption, exports.
- **Abuse:** the threat model's TB1 rows are updated (the customer link; guessing an id). The FIN leak was an insider at one branch reading another branch's books by id; it is now refused, with `AUTHORISATION_FAILURE` audited by the authoriser. No new abuse path.

## Deferred

- None from this phase's gate.
- Open for B12: FIN's statements and account activity stay farm-wide (A-258); B12's reporting may narrow them if the owner wants it.

## Contract requests

I fetched the frontend's `main` at `878c285`: CR-001 to CR-034.
- **CR-034 (new since B09q):** answered by 2.0.0. The server generates the SKU (`EGG-0001`), `sku` on create or update is 422 `FIELD_SERVER_ASSIGNED`, the SKU never changes, the product sheet names a product by SKU and a blank one creates, and `listProducts` searches by it. Nothing more to build.
- **CR-033:** points 1 and 2 stay with B9b, and point 3 with B11. **Declined in the requested form:** the link cannot name the sale's client id (`/shop/receipts/{saleId}`), because decision 5 forbids an id as a key and a UUIDv7 is not secret. B9b gives the till an `rcp_` token of its own, drawn from Web Crypto when the sale is made (it works offline), with only its hash stored on the server (ADR-0074). The frontend's `OfflinePack.receiptLinkTemplate` should take `{token}`, not `{saleId}`; B9b answers it.
- **CR-016:** labels print text (2.0.0), as B09q said.
- **CR-031 and CR-032** stay with B9b. **CR-018** stays with B12.
- The others were answered in earlier phases, as B09q's report lists.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,489 passed**, 127 files |
| Coverage, merged (`pnpm test:coverage`) | **3,025 passed**, 245 files, exit 0. Statements 94.14 percent, branches 84.32 (gate 80), functions 97.62, lines 96.75. Every 100 percent gate held, including the new `src/platform/crypto/link-tokens.ts`. |
| Integration (in the merged run) | New: `iam/no-id-is-a-key` (11), the `ord/online-orders` trackOrder block (7, replacing 1), FIN branch tests (2). The handler walk is unchanged in its assertions. |
| Contract | **118 passed**, 44 files |
| Lint, typecheck | Clean (boundary rule, 22 lint fixtures, 297 specs in place, schema names) |
| Secret scan | gitleaks v8.28.0 over the whole history: no leaks (after the fix above) |
| End to end | CI only |

## Gate

**Passed.**
- Knowing a public ID, a SKU or a UUID gets you nothing. Every operation that takes one refuses an anonymous caller, another customer, and a staff role without the permission or outside its branch, with a test generated per operation and the refusals mutation-checked.
- The tracking link carries its own random token of 256 bits, stored only as its hash and never derived from an id. A guessed, altered or another order's token reads nothing.
- The rule B9b's receipt link and B11's message links follow is named (ADR-0074).
- No shape of 2.0.0 changed (2.0.1, descriptions and one example).

## Notes for the frontend track

- 2.0.1 changes no shape. Treat `trackingToken` as opaque and build the link from the latest `placeOrder` answer: a replay gives a fresh token, and both work for 30 days.
- CR-033: the receipt link will carry a token the till draws itself (`{token}`, not `{saleId}`). B9b confirms the shape.
- A staff screen at one branch no longer sees another branch's journal entries, manual journals, fixed assets or depreciation runs (403 by id; absent from lists).

## CI

- **`6d3c612`** (pull request #86 opened on it): run **44078351987 (push) failed**: secret scan only, fixed in `fix(shp)` as above.
- The runs on the following commits, and on the final head (this report's commit), are named in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09e, copied from `docs/prompts/session-openers.md` (unchanged).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09q2-no-id-is-a-key.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decisions below, ADR-0018 (valuation and cost accumulation), ADR-0048, A-157 and
B06u's report on unit conversions, docs/data-model/mdm.md, inv.md and pur.md, and the MDM, INV and PUR cards in
docs/MODULE_BOUNDARIES.md. Load hakorem-money, hakorem-pricing, hakorem-stock, hakorem-ledger, hakorem-migration,
hakorem-endpoint and hakorem-tests. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09e only, on branch b09e-eggs, branched from main. The owner's decisions (2026-11-17), each test-first
with exact pesewa assertions:
1. Price per selling unit: a crate and a single egg each carry their own price on the price list; never derive a
   crate's price from a per-egg price. Stock stays held in eggs. The engine resolves the price of the unit sold.
2. Cost without drift: keep each delivery's total cost and spread it across its eggs with largest-remainder allocation
   (the kernel's allocate, as the distributions do); never round cost egg by egg. A crate bought at GHS 47.50 and sold
   whole posts cost of exactly 4,750 pesewas; a crate broken into singles posts costs summing exactly to 4,750. Read
   ADR-0018 first: if lot-level exact cost contradicts its valuation method, STOP and report the options to the owner
   rather than building.
3. Lines in crates: goods receipts, orders and transfers accept a line in crates or in eggs, converted by the server
   through MasterDataRefs.toBaseIn (B06u), never with a factor of their own.
4. A received date on every bought lot; sell oldest first by expiry, then by received date, wherever the server picks a
   lot (promisable stock, reservations, checkout, and the sale when no lot is named).
5. Cracked on arrival: a reason on every rejected quantity (CRACKED, BROKEN, DIRTY, SHORT, as reason codes), and a
   claim raised from the receipt that drafts the supplier credit note from the rejected lines and their cost, instead
   of keying it by hand; the credit note keeps its existing approval (maker and checker apart).
6. Quantity breaks and reorder points counted in the selling unit (10 crates), stored in eggs.
7. A purchase order line defaults to the last price paid to that supplier for that product; no full supplier price
   list yet.
Not in this phase: returnable trays and crates (BL-074, until the owner confirms); registered checkout and order
promotions (BL-072, BL-073). Kasoa and KNUST are real selling points the owner creates through the API: never seed them.
Additive contract changes only, unless one is unavoidable and recorded loudly.
Stop at the gate, write docs/sessions/B09e-eggs.md, and merge into main when every run on the pull request is green.
```
