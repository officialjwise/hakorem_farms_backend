# Contract changelog

Every change to `contract/openapi.yaml`, newest first. A breaking change needs a major version bump, an entry here, and a line at the top of the session report so the frontend track picks it up.

Version numbers follow semantic versioning: a major bump breaks an existing client, a minor bump adds operations or optional fields, a patch fixes descriptions or examples.

## Requests answered without a change

- **CR-002 (frontend, raised 2026-11-13): weights as decimal strings, never JSON numbers.** Already satisfied by 1.0.0 and 1.1.0, so no version change. `components.schemas.Kilograms` is `type: string` with the pattern `^(0|[1-9][0-9]{0,6})\.[0-9]{3}$` (exactly three decimal places), and its description says it is never a JSON number. The request was raised against a copy taken before re-syncing; re-run `./scripts/sync-contract.sh`. The owner closed it on 2026-11-13: do not reopen it.

## 1.4.0 (2026-11-14, B4)

**Additive only.** A client generated from 1.3.x keeps working; it simply does not read the new field.

- **`TotpEnrolment.qrCodeDataUri` (CR-006 point 2)**, always present, in the response of `startTotpEnrolment`: the `otpauthUri` drawn as a QR code, an SVG image as a data URI (`data:image/svg+xml;base64,…`). Show it in an `<img>` with a text alternative, and keep `secretBase32` on screen for a phone that cannot scan. The QR code carries nothing the response did not already carry: it is the same URI, drawn. The example in the contract is a real code that decodes to the example's own `otpauthUri`, so the mock serves one that scans (ADR-0037).

## 1.3.0 (2026-11-14, B4)

**Additive only. No existing shape changed: no field, schema, parameter or response was removed, renamed, retyped or made required.** A client generated from 1.2.x keeps working unchanged. The frontend track is paused; when it resumes it should read this entry first, because nothing reviewed it when it was made.

Seven more operations now answer from the real API (24 in all), and their published text is the code's (ADR-0031): `resolvePrices`, `createPriceList`, `getPriceList`, `createPriceListVersion`, `getPriceListVersion`, `replacePriceListEntries`, `submitPriceListVersion`. Their request and response schemas are the ones 1.2.0 already published.

- **`x-requires-step-up: true` (CR-007)** beside `x-permission` on the 30 operations whose description says "Requires step-up". A test keeps the flag and the prose in step, and an integration test keeps the flag equal to `iam.permission.requires_step_up` for every permission the database has seeded. A screen can now ask for the TOTP code before the write instead of after a 403 `STEP_UP_REQUIRED`. `approveRequest` and `rejectRequest` carry no flag: whether a decision needs step-up depends on the approval kind's policy (`PRICE_LIST_ACTIVATION` does), so they still answer 403 `STEP_UP_REQUIRED` when it is needed.
- **Examples (CR-008):** the 200 examples of `listBranches` (three rows listed twice), `listSpeciesList` and `listDeliveryZones` (one row each) no longer repeat a row. A contract test now refuses any example list that repeats an id. The 202 example of `submitPriceListVersion` names a `PRICE_LIST_VERSION` subject instead of a stock adjustment.
- **`x-error-codes`** on the seven new operations. One new code, also in `docs/API.md` section 10.3: `PRICE_ENTRY_INVALID` (422, an entry breaks a price rule: floor above list, list above ceiling, a zero floor on a priced entry, a grade or band of another species). `PRICE_ENTRY_DUPLICATE`, `INVALID_STATE_TRANSITION`, `DUPLICATE_VALUE` and `REFERENCE_NOT_FOUND` were already catalogued.
- **Behaviour a client should know, with no shape change:**
  - `submitPriceListVersion` always answers **202 `ApprovalPending`**; activation is always maker-checker. Its documented 200 response is never returned in this version and stays only so the published shape does not change.
  - `resolvePrices` returns `promotions: []` on every line until promotions are built (B04 continued); a `couponCode`, and a line's `stockUnitId` until inventory exists (B5), name no record and answer 422 `REFERENCE_NOT_FOUND` naming the field. A line the engine cannot price is still a 200 with `outcome: QUOTE_REQUIRED`, never an error.
  - A version whose `validFrom` has passed when it is approved starts at the moment of approval, so `getPriceListVersion` can show a later `validFrom` than was drafted (ADR-0036).
- **Not in this version (CR-006 point 2):** `TotpEnrolment.qrCodeDataUri` waited for the owner's decision on the dependency; it is in 1.4.0.

## 1.2.0 (2026-11-14, B3)

Additive only. A client generated from 1.1.x keeps working. Seventeen operations are now implemented in code and answer from the real API; their published text is the code's (ADR-0031). The frontend should regenerate its client and switch these operations off its stub: `getHealth`, `loginStaff`, `loginCustomer`, `loginInvestor`, `verifyTotp`, `refreshSession`, `logout`, `getCurrentSession`, `changePassword`, `startTotpEnrolment`, `confirmTotpEnrolment`, `stepUp`, `listSessions`, `revokeSession`, `listProducts`, `createProduct`, `getProduct`. The login flow, token lifetimes and cookie attributes are in `docs/sessions/B03-platform-slice.md`.

- **Login challenges carry the steps between password and session.** `PasswordChangeRequest` and `TotpCodeRequest` gain an optional `challengeToken`; `startTotpEnrolment` gains an optional request body, the new schema `TotpEnrolmentStart` (`challengeToken`). During login these three operations take the challenge in the body and no cookie, so they use `CsrfTokenOptional` and list an empty security requirement beside the session schemes. `confirmTotpEnrolment` during login also completes the login: the session cookies are set on its response.
- **`realm` query parameter (optional)** on `refreshSession`, `getCurrentSession` and `logout`: which session to use when one browser holds sessions in more than one realm. Leave it out with one session. With several and no `realm`, the API answers 400 `VALIDATION_FAILED` naming `/realm` (refresh: 401).
- **`x-error-codes`** on every implemented operation lists the codes it can raise, adopting the "Added" codes of `docs/API.md` operation by operation (A-074). New codes, also in `docs/API.md` section 10.3: `TOTP_ALREADY_ENROLLED`, `APPROVAL_SUBJECT_CHANGED`, `DUPLICATE_VALUE`, `REFERENCE_NOT_FOUND`, `STOCK_POLICY_CONFLICT`.
- **New responses:** 503 `ServiceUnavailable` on the login operations, `verifyTotp` and `refreshSession` (the login rate limit fails closed when Redis is down); 403 `Forbidden` on `refreshSession` (`ORIGIN_NOT_ALLOWED`).
- **Descriptions:** `getHealth` names the checks reported so far (database, Redis, outbox backlog, dead letters, audit sealing lag) and says DEGRADED still answers 200; `verifyTotp`, `refreshSession`, `changePassword`, `startTotpEnrolment` and `confirmTotpEnrolment` describe the challenge and realm rules. `ErrorBody.code` and `CsrfTokenOptional` describe the above.
- **Not yet accepted:** API keys (`apiKey` security) on the implemented operations answer 401 until integrations arrive (A-084); the schemes stay in the contract as the target.

## 1.1.0 (2026-11-13, B1)

Additive only: new optional fields and enum values. A client generated from 1.0.x keeps working; the POS offline queue should adopt the new fields.

- `TenderInput.unverifiedMobileMoney` (optional): an offline mobile money tender taken under the setting `pos.offline.allow_unverified_mobile_money`, with payer phone, network, any reference shown, and the approving manager.
- `ShiftClose.lastDeviceCounter` (optional): so a gap after the last synced sale is detected at close.
- `OfflineSyncBatch.sales`: at most 500 per batch. `OfflineSyncResult.cashMovementResults`: an outcome per synced cash movement.
- `DriverSyncItem.outcome`: adds `APPLIED_WITH_EXCEPTION`.
- `GoodsReceiptCreate.kind`: adds `OPENING` for opening stock (`docs/DATA_MIGRATION.md`).
- `ExceptionKind`: adds `SYNC_REJECTED` and `LATE_POSTING`.
- Example: the opening balance manual journal now shows bank against opening balance equity.

## 1.0.1 (2026-11-13, B1)

Examples and one description only. No operation, field or schema changed; a client generated from 1.0.0 needs no change.

- Catalogue and product page: catch-weight prices are per kilogram, as `priceBasis` says (goat meat GHS 26.00 per kg, not a pack price).
- Quotes: the standard-rated delivery fee carries its levies (GHS 12.00 on GHS 60.00); the quote list no longer repeats one total.
- Animals and stock on hand: an animal's `priceBand` is the band for its weight band; processed animals in processing and trace examples are no longer animals shown alive elsewhere.
- Receivables: Royal Palm Hotel's overdue invoice is 24 days late (1 to 30 bucket), consistent with its account not being on hold.
- Exceptions: the stock exception item carries abuse case 11 only; case 10 is a device counter gap.
- `CapitalTransactionCreate.unitPricePesewas`: the default is GHS 100.00 per unit, matching every example and ASSUMPTIONS A-031.

## 1.0.0 (2026-11-13, B1)

First version, written by hand before any endpoint exists so the frontend can build against a mock server.

- **Scope:** 600 operations on 476 paths, covering every module in the shared brief, including those not built until B12. 807 schemas. Tagged by module, grouped for Redoc with `x-tagGroups`.
- **Conventions:** money as integer `...Pesewas` fields with `currency` on the object; weights, quantities and percentages as decimal strings; one error envelope with `correlationId`; cursor pagination; `Idempotency-Key` on every state-changing request and `X-CSRF-Token` on cookie-authenticated ones; 202 `ApprovalPending` for maker-checker actions (ADR-0029).
- **Security schemes:** staff, customer and investor session cookies (`__Host-hk_s_at`, `__Host-hk_c_at`, `__Host-hk_i_at`), integration API keys, and a POS device credential.
- **Extensions:** `x-permission` on every staff operation names the permission the domain layer checks; `x-owner-module` where the owning module differs from the tag.
- **Examples:** every list operation has at least five realistic rows from one consistent seeded farm in Dodowa. Counter sale, tax, processing cost and distribution figures are computed with the same largest-remainder rule the backend will use, so they are exact.
- **Frontend requests:** CR-001 implemented (`unitCostPesewas`, `valueAtCostPesewas`, `valuationMethod`, `totalValueAtCostPesewas`, `asOf` on `GET /stock/on-hand`; cost and price never share a field). Enum values are upper case: `WEIGHTED_AVERAGE`, `SPECIFIC_IDENTIFICATION`.
- **Lint:** `npx @redocly/cli lint contract/openapi.yaml` passes with no errors and no warnings under `redocly.yaml` (recommended rules; the localhost server warning is turned off because the local and mock servers are listed on purpose).
