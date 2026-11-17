# B09x continued: the business profile and the shop's contact details (CR-028)

Date: 2026-11-17 · Branch `b09x2-shop-profile`, from `main` (`4a519e6`) · Status: **built, gate passed**. B9b runs next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-242 | **Who reads the profile in the console:** `aud.setting.read` (0208, 0209) for the Owner and the Manager only, FR-AUD-008's two actors; only the Owner changes it (`aud.setting.manage`, step-up). | Owner |
| A-243 | **The shop profile's cache:** `Cache-Control: public, max-age=300`; a 404 or error keeps `no-store`; the `public` rate limit per address, failing open like the catalogue. | Owner |
| A-244 | **The profile as stored:** one `platform.setting` row per version under `aud.business_profile` (`JSON`, farm-wide); a PUT replaces it whole from now, an optional field left out cleared; each row carries the previous `version` plus one; `updatedAt` is the row's `valid_from` by the application clock; `updateSetting` cannot reach it. Receipt footer not a field yet; no document reads the profile yet. | Owner |
| A-245 | **Opening hours:** `{ day, opens, closes }` in Africa/Accra `HH:MM`, at most 21, several a day allowed, none across midnight, never overlapping (they may meet); stored in week order. No holidays yet. | Frontend |
| A-246 | **The logo:** a `PRODUCT_IMAGE` file scanned `CLEAN` and of an image type, else `LOGO_NOT_USABLE`; no `LOGO` purpose added; the shop profile has no logo. | Owner |
| A-247 | **The seeded profile:** set once by the seeded Owner; `+233200000120` and `+233200000121` from the seed block, TIN `C0000000001`, no VAT number, an `.invalid` email, `(SEED)` on every text, illustrative hours. | Owner |

Resolved: **A-241** (CR-028's split: the profile now exists).
Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-204, A-206, A-207, A-209, A-211, A-213, A-214, A-216 to A-240, A-242 to A-247.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09x continued (`b09x2-shop-profile`, from `main` at `4a519e6`).
2. **Scope:** the business profile in `platform.setting` through AUD's audited administration (`getBusinessProfile`, `updateBusinessProfile`), CR-028's `getShopProfile`, and the seed.
3. **Gate:** stored in `platform.setting`, written only through AUD (`aud.setting.manage`, step-up, before and after audited); `getShopProfile` anonymous and cacheable with exactly the contact fields (a test lists the keys), 404 while unset; the seed writes it through AUD as the seeded Owner with invented numbers; every write refuses the wrong role.

## Contract changes

**1.54.0, minor. No field removed, renamed or retyped, and nothing a client of an implemented operation sends made required. No answer of an implemented operation changed.**
- New `getShopProfile` (`GET /shop/profile`, `shp`, anonymous) answering the new `ShopProfile` (`additionalProperties: false`).
- `getBusinessProfile` and `updateBusinessProfile` move from planned into code, descriptions made exact, `x-error-codes` added; `getBusinessProfile` gains `404`.
- `BusinessProfile` gains `whatsapp`, `directions`, `openingHours` (required in the answer; the operation was planned until now); `BusinessProfileUpdate` gains them as optional and states the lengths the server enforces; new `OpeningInterval`.
- `SETTING_INVALID` gains the details `CLOSES_BEFORE_OPENS`, `HOURS_OVERLAP`, `LOGO_NOT_USABLE`.
- `components.x-seeded-roles`: the Owner and the Manager gain `aud.setting.read`.
- 422 operations from code, 214 planned (636). `contract:generate --check` up to date; Redocly clean with no warnings; the versioning check against `main` passes.

## Built

| Area | What |
| --- | --- |
| AUD domain | `business-profile.ts`: the key, `judgeOpeningHours` (refuses closing at or before opening and overlap, sorts by week), `shopProfileOf` and `SHOP_PROFILE_KEYS` (the shop's shape is built field by field, so a field added to the profile cannot reach it). |
| AUD application | `BusinessProfiles`: `get` (`aud.setting.read`), `update` (`aud.setting.manage`, step-up from the permission, idempotent, serializable, version check, logo check, a new effective-dated row, audit `BusinessProfile` UPDATE with before and after) and `shopProfile` (no actor, contact fields only). Published in `index.ts`. |
| AUD interface | `BusinessProfileController` (`GET`/`PUT /admin/business-profile`), the strict `BusinessProfileUpdate` schema (E.164 phones, no normalisation), fragments moved from the planned file. |
| Platform | `Settings.insertIn` takes an optional `version` (default 1, as before). |
| SHP | `ShopProfile` handler over AUD's `shopProfile` (404 while null); `getShopProfile` on the shop controller with `Cache-Control: public, max-age=300` and the `public` rate limit. SHP imports AUD. |
| Migrations | 0208 seeds `aud.setting.read` (granted to no role), 0209 grants it to the Owner and the Manager; both roll back (the 0155 rollback walk covers them). |
| Seed | `farm-aud.ts`: the seeded Owner sets the profile through `BusinessProfiles`; a second run writes nothing. |
| Docs | A-241 resolved, A-242 to A-247; the changelog; API.md (section 2 `Cache-Control`, 10.3 `SETTING_INVALID`, the AUD and SHP sections); `docs/data-model/platform.md` (the key); the AUD and SHP cards in MODULE_BOUNDARIES; B9b's opener points its receipt at `BusinessProfiles`. |

## The gate, proved by running it

- **Stored and administered through AUD:** one `platform.setting` row per version under `aud.business_profile`; version 1, then 2, the first row kept; the audit event carries nothing before and the profile after on the first set, then the profile before and after; a replay with the same key answers the stored response and writes nothing; a stale version is 409; two concurrent changes from one version land one and refuse the other with 409; `updateSetting` with the key is 404.
- **Wrong role refused, test-first:** the Manager, Accountant, Storekeeper, Cashier, Sales, Farm hand and Driver are 403 on the change, the Owner without a step-up in five minutes 403 `STEP_UP_REQUIRED`, nothing written; the Accountant and the five other roles are 403 on the console read; the handler walk refuses a user with no grant on both.
- **Validation:** closing before opening and overlapping hours are 422 `SETTING_INVALID` naming the interval; a WhatsApp or phone number not in E.164 and an unknown field (`bankAccountNo`) are 400; a missing logo file and a clean `EVIDENCE` file are 422 `LOGO_NOT_USABLE`; a clean `PRODUCT_IMAGE` is accepted.
- **CR-028:** `GET /shop/profile` without a session answers exactly the keys `address`, `directions`, `openingHours`, `phone`, `tradingName`, `whatsapp` (each interval exactly `closes`, `day`, `opens`), with none of the TIN, VAT number, legal name, email, version or logo, `Cache-Control: public, max-age=300` and no cookie; 404 `NOT_FOUND` with `no-store` before a profile is set; with the public limit lowered to 1 a minute, the next read is 429 `RATE_LIMITED` with `Retry-After`. The contract test checks that `ShopProfile`'s properties and required list equal `SHOP_PROFILE_KEYS` and that it allows nothing else.
- **Seed:** the seeded Owner (Kwabena Owusu, user agent `hakorem-seed`) set it once at version 1; both numbers in `+2332000001..`, the email in `.invalid`, `(SEED)` on every text; the shop answers the seeded details; a second seed run writes nothing.
- **Mutation:** making `shopProfile` hand out the whole profile, and authorising the change with the read permission, turned six tests red; restored, green.

## Test first, as it honestly happened

- The unit spec was written and run red (the module did not exist) before `business-profile.ts`.
- The integration spec was written and run red (10 of 12 failing on 404: no route) before the application and interface. Two passed vacuously at that point (the 404s before a profile exists). Its first green run failed on the test's own set-up (a stored file must be inserted `PENDING` and passed by the worker, and needs a 32-byte hash), fixed in the test.
- The seed assertions were written after the seed unit and first run green.
- Stale tests updated because this phase made them stale: the handler walk (three routes, a valid body), the 0155 rollback walk (0209, 0208), the drift count (636 operations, 214 planned), and the request-example parse map (`updateBusinessProfile`), which the first full contract run found red and which now passes.
- Nothing was skipped, quarantined or retried, and no test was re-run to turn it green.

## Decisions

None needing an ADR: the store is the one the data model names; the cache lifetime follows docs/API.md section 2; the rest are reversible assumptions (A-242 to A-247).

## Security review (hakorem-security-review)

- **Boundaries:** TB1 public storefront (`getShopProfile`), TB7 system administration (`updateBusinessProfile`).
- **Authorisation:** checked in the handler (`BusinessProfiles.get`, `update`), deny by default; the permission's `requires_step_up` gives the change its step-up; wrong roles refused by test. `aud.setting.read` granted to two roles only.
- **Exposure:** the public shape is built field by field in AUD (`shopProfileOf`), so SHP never holds the TIN, VAT number, legal name, email or logo; schema `additionalProperties: false`; tested by key list and by contract.
- **Input:** strict schema, unknown fields 400, E.164 only, lengths bounded, the logo file checked for purpose, scan and type; parameterised queries only.
- **Audit and data:** every change audited with before and after; the farm's own tax numbers are printed on its documents and are not secrets (DC-14 holds: no secret in `platform.setting`); no bank detail in the profile.
- **Rate limit and caching:** the `public` group per address (proved); public cache only on success, `no-store` otherwise, no cookie set.
- **Abuse path:** a changed shop number could divert buyers, but only the Owner can change it, with a fresh TOTP step-up, and every change is audited with before and after; no new exception kind is needed. Not applicable: uploads (only an existing file is referenced), payments, webhooks, exports.

## Deferred

- No document prints the profile yet; B9b's public receipt (CR-033) is the first reader (A-244). FR-AUD-008's receipt footer and `listSettings` are not built.

## Contract requests

I fetched the frontend's `main` at `0efb338`, the commit B09x read. It lists CR-001 to CR-033; nothing is new or changed.
- **CR-028: done** (1.54.0): `getShopProfile`, anonymous and cacheable, with the trading name, the phone and WhatsApp numbers in E.164, the address and directions, and the opening hours; 404 while no profile is set.
- **CR-031, CR-032 and CR-033** stay placed in B9b, next (CR-033's SMS in B11).
- **CR-018** stays with B12's `runReport`.
- **CR-005, CR-023 and CR-027** were done in B09x (1.53.0); **CR-013** in B09a continued 2g.
- The others were answered in earlier phases (CR-012 1.20.0; CR-014 to CR-017 1.21.0; CR-020 1.38.0; CR-026 1.40.0; CR-030 1.43.0; CR-009 to CR-011, CR-019, CR-021, CR-025 and CR-029 in their phases).

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,473 passed** (new: 7 in `aud/domain/business-profile.spec.ts`) |
| Coverage, merged (`pnpm test:coverage`, unit and integration) | **2,960 passed**, 239 files, exit 0. Statements 93.77 percent, branches 83.66 percent (gate 80), functions 97.22, lines 96.40. Every 100 percent gate held. New files: `business-profile.ts` 100/100, `business-profiles.ts` 100 lines, 93.33 branches, `shop-profile.ts` 100/100 |
| Integration (in the merged run) | new: 12 in `aud/business-profile`, 2 in `platform/seed` |
| Contract | **110 passed**, 43 files (new: 3 in `b9/business-profile`). The first full run was red on one stale test (the request-example parse map lacked `updateBusinessProfile`), fixed in its own commit; the rerun is green |
| Lint, typecheck | Clean (`pnpm lint`: boundary rule, lint fixtures, 290 specs in place, schema names) |
| End to end | CI only |

## Gate

**Passed.**
- The business profile is stored in `platform.setting` as the data model says, and written only through AUD's audited administration (`aud.setting.manage`, step-up, the profile before and after in the audit event).
- `getShopProfile` answers anonymously and cacheably with the trading name, a phone and a WhatsApp number in E.164, the address and directions, and opening hours, and nothing else, proved by a test listing the keys; 404 while no profile is set.
- The seed writes the profile through AUD as the seeded Owner with invented numbers from the seed block, and a second run changes nothing.
- Every write refuses the wrong role.

## Notes for the frontend track

- **Contract 1.54.0.** `getShopProfile` for the footer and every "call us" line; `whatsapp` may be null; a WhatsApp link is `https://wa.me/` and the number without its `+`. Show no number on 404.
- `BusinessProfile` now has `whatsapp`, `directions` and `openingHours`. `updateBusinessProfile` replaces the whole profile: send every field you want kept. Mark the public fields on the settings screen.
- The profile screen is for the Owner (change, with step-up) and the Manager (read).

## CI

- **`761ac88`** (all code, tests and documents before this report; pull request #81 was opened on it): run **44052153703 (push)**, success; run **44052203814 (pull_request**, which also compares the contract with `main`), success.
- `8f5ede2`, `44aa553` and `c9024f6` were pushed together with `761ac88` and had no run of their own.
- Nothing was red in CI and nothing was re-run.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B9b, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09x2-shop-profile.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0015, ADR-0027 and the abuse cases 4, 10, 11 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b only, on branch b09b-pos-shifts-offline: registers and device enrolment, shifts with
the opening float, cash movements and cash drops, X and Z reports, blind close with supervisor sign-off
and over/short posting, held sales, the offline pack, and offline sync: exactly-once by client UUIDv7,
the gap-free device counter, provisional references, occurred-at and recorded-at, cash-only tenders
offline, the stock exception instead of a refusal, price override bounds re-checked at sync. Write
the five conflict tests ADR-0027 names (animal sold elsewhere, animal on hold, countable stock gone
negative, sale in a locked period, missing device counter) and the 500-transaction test with the network
disabled. Run scenario 6 of docs/UAT.md as a dry run and record any difference.
Check that counter sales reach the owner dashboard's sales figures and the getSalesTodayTile and getSalesSeries
tiles B9a made live (B05x, A-149): a seeded counter sale appears in today's sales by channel POS, test-first.
The owner's two additions to A-200 (2026-11-16), each test-first:
(1) An offline sale synced later is issued at its occurred_at, the time it happened at the till, not the sync time:
that is the real transaction time, not a backdate. Extend Billing.issueIn additively to take that time for a synced
sale only, mark the document as synced from offline (a field the receipt and the document read show), and bound how
old an offline sale may be (a setting, conservative default, recorded in ASSUMPTIONS.md): a sale outside the bound is
still recorded, never refused (a synced sale is always recorded), and reaches the exception report; a sale whose
period has since locked posts on the first open date, flagged, keeping its occurred_at (ADR-0027 point 6).
(2) A business buyer at the counter may have their name and TIN printed on the VAT invoice without opening a customer
account, so they can reclaim the input tax: optional buyer name and TIN on the counter sale and the billing document,
validated in format, printed on the invoice, and never creating a customer; the walk-in party stays.
The owner, 2026-11-16 (A-212 (a)): cash enters only through a till shift. Build a customer paying an invoice at the till
inside the shift, counted at close, and refuse any cash payment outside an open shift, test-first.
The frontend's CR-031 and CR-032 (planned in contract 1.45.0 by B09a continued 1d): fill OfflineProduct.taxInclusive
from each product's price list, SyncResultItem.grossPesewas (null when nothing was recorded) and its currency, and the
pack's CASH_MOVEMENT reason codes; decide CR-032 point 2, the offline PIN verifier (an operation that sets a till
PIN and the salted verifier the device stores, or a statement in OFFLINE_SYNC.md that the device derives it from the
PIN typed at an online sign-in), record it as an ADR and answer it in the report.
CR-033 points 1 and 2 (owner's rule, 2026-11-16: every sale produces a digital receipt, by SMS or a link, and a printer
is optional): a public receipt read with no session, by an unguessable token, answering the official number, the sale
reference, the lines, the tenders, the change and the business's details, and "being recorded" until the sale has
synced; the till can make the link offline so it shows as a QR code at the counter. Choose the token with
hakorem-security-review: the frontend suggests the sale's client id (a UUIDv7, whose leading bits are a timestamp);
prefer a value the device derives from its enrolled credential if the client id proves too guessable, and record the
choice as an ADR. Rate-limit the read, expose no other customer's data, and test that a guessed or another sale's token
answers 404. The SMS on sync (point 3) is B11's.
Stop at the gate and write docs/sessions/B09b-pos-shifts-offline.md.
```
