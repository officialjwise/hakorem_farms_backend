# Table dictionary: `quo`

Owner: QUO module. Requests for quote, quotes with immutable versions, acceptance by signed link, and conversion to an order. Conventions are in `docs/DATA_MODEL.md`.

---

### `quo.rfq` · DOCUMENT

A request for quote. Posted statuses: `QUOTED`, `CLOSED`, `SPAM`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `rfq_no` | `text` | NULL, UNIQUE | |
| `source` | `text` | NOT NULL, CHECK in (`PUBLIC_FORM`, `REQUEST_TO_BUY`, `PHONE`, `WHATSAPP`, `COUNTER`, `WHOLESALE_ORDER`) | Where it came from |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | Set when matched or registered |
| `contact_name` | `text` | NOT NULL | |
| `contact_phone_e164` | `text` | NOT NULL | |
| `contact_email` | `text` | NULL | |
| `requirements` | `text` | NOT NULL | Free text: "twenty goats, about 25 kg each, for a funeral on the 14th" |
| `product_id` | `uuid` | NULL, FK `mdm.product` | Set for a request to buy a listed product |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | A particular animal the buyer asked about |
| `qty` | `qty` | NULL, CHECK `> 0`; with `uom`, and only with `product_id` (`ck_rfq_qty`) | B10, item 4: how many |
| `uom` | `text` | NULL, FK `mdm.uom` | A unit the product is sold by, checked by the application (an exact conversion, B06u) |
| `needed_by` | `date` | NULL | |
| `delivery_area` | `text` | NULL | |
| `assigned_to` | `uuid` | NULL, FK `iam.principal` | Salesperson |
| `submitted_ip` | `inet` | NULL | Rate limiting and abuse review for the public form |
| `consent_to_contact` | `boolean` | NOT NULL; true on a storefront request (`ck_rfq_public`) | |

Standard columns: `DOCUMENT` (`status` in `NEW`, `IN_PROGRESS`, `QUOTED`, `CLOSED`, `SPAM`).

### `quo.quote` · DOCUMENT

The quote as a whole. Its content is in versions. Posted statuses: `ACCEPTED`, `DECLINED`, `EXPIRED`, `CONVERTED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `quote_no` | `text` | NULL, UNIQUE | Stays the same across versions |
| `rfq_id` | `uuid` | NULL, FK `quo.rfq` | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | |
| `contact_name` | `text` | NOT NULL | |
| `contact_phone_e164` | `text` | NOT NULL | |
| `salesperson_id` | `uuid` | NOT NULL, FK `iam.principal` | Win rate by salesperson |
| `product_line` | `text` | NULL | Win rate by product line |
| `current_version_no` | `integer` | NOT NULL DEFAULT 1 | |
| `accepted_version_id` | `uuid` | NULL, FK `quo.quote_version` | |
| `converted_order_id` | `uuid` | NULL, UNIQUE, FK `ord.sales_order` | A quote converts to exactly one order |
| `decline_reason` | `text` | NULL; set exactly when `DECLINED` | |
| `cancel_reason` | `text` | NULL; set exactly when `CANCELLED` | B10. Answered as `Quote.cancelReason` (2.43.0); a quote cancelled after issue is the pipeline's `withdrawn` outcome (A-354) |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `PENDING_APPROVAL`, `ISSUED`, `ACCEPTED`, `DECLINED`, `EXPIRED`, `CONVERTED`, `CANCELLED`).

### `quo.quote_version` · DOCUMENT

One revision. Immutable once issued; a change is a new version. Posted statuses: `ISSUED`, `SUPERSEDED`, `ACCEPTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `quote_id` | `uuid` | NOT NULL, FK `quo.quote` | |
| `version_no` | `integer` | NOT NULL, CHECK `> 0` | |
| `status` | `text` | NOT NULL, CHECK in (`DRAFT`, `PENDING_APPROVAL`, `ISSUED`, `SUPERSEDED`, `ACCEPTED`) | |
| `valid_until` | `timestamptz` | NOT NULL | Validity period |
| `terms` | `text` | NULL | |
| `delivery_estimate` | `text` | NULL | |
| `delivery_fee_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `tax_inclusive` | `boolean` | NOT NULL | |
| `net_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `tax_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Estimate from the tax calculator; from B11u the delivery fee's tax is in it, a `DELIVERY_SERVICE` line in the version's pricing mode as the invoice takes it (A-352) |
| `gross_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `estimated_cost_pesewas` | `pesewas` | NULL | For margin |
| `margin_percent` | `numeric(9,2)` | NULL | **Markup over cost, not margin** (the owner, 2026-11-23, migration 0307's comment): (the lines' net less cost) over cost; may be negative or above 100, so not `percent` (A-309 (c)). Answered as `markupPercent` and, deprecated, `marginPercent`; to be renamed `markup_percent` in the next release (BL-098). The margin over price is derived from `net_pesewas` and `estimated_cost_pesewas` on read, never stored (A-342) |
| `below_margin_floor` | `boolean` | NOT NULL DEFAULT `false` | |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required to issue when `below_margin_floor` | |
| `approved_by`, `approved_at` | `uuid`, `timestamptz` | NULL, together; never the author nor the issuer (`ck_quote_version_margin_approved`) | B10, FR-QUO-005 |
| `change_note` | `text` | NULL | What changed from the previous version |
| `issued_at` | `timestamptz` | NULL | |
| `issued_by` | `uuid` | NULL, FK `iam.principal` | |
| `archived_document_id` | `uuid` | NULL, FK `doc.archived_document` | The PDF sent: revision `version_no` of the quote's archived document, set once by `quo.quote-archive-link` (B10 continued 5, A-330) |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `created_by` | `uuid` | NOT NULL, FK `iam.principal` | |

- UNIQUE (`quote_id`, `version_no`); at most one `ISSUED` and one open (`DRAFT`, `PENDING_APPROVAL`) version per quote. Issuing a version sets the issued one to `SUPERSEDED`. Issued, a version is frozen but for its status (`ck_quote_version_frozen`, HK004). The acceptance link's token hash is in `quo.quote_link_token` (ADR-0087).


**As changed in B10 continued 3b (migration 0278, A-323, the owner, 2026-11-19):** `status` gains `APPROVED`: a version below the margin floor that a second person approved, holding no stock, having sent nothing and having no link. `quo.quote_version_guard` moves `PENDING_APPROVAL` only to `DRAFT` or `APPROVED`, `APPROVED` only to `ISSUED`, exactly as approved; `ck_quote_version_approved_state` (an APPROVED version names its approval and an approver who is not its author); `uq_quote_version_open` counts APPROVED as open.
### `quo.quote_line_stock` · LEDGER

What a product line of a version found on hand and held when it was issued (B10 continued 5, migration 0288, A-328, the owner's item 3 of 2026-11-18, ADR-0019). Data category: CONFIDENTIAL (DC-22); the buyer sees only whether a line is subject to stock.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `quote_line_id` | `uuid` | NOT NULL, FK `quo.quote_line`, UNIQUE (`uq_quote_line_stock_line`) | once per line |
| `quote_version_id` | `uuid` | NOT NULL, FK `quo.quote_version`; the line's own, recorded before it is `ISSUED` (`quo.quote_line_stock_check`, HK004) | |
| `available_qty` | `qty` | NOT NULL | on hand to promise at the branch in the base unit; a balance below zero counts as nothing (ADR-0081) |
| `held_qty` | `qty` | NOT NULL, `<= available_qty` (`ck_quote_line_stock_held`), `<=` the line's `base_qty` (the check trigger) | what the version reserved; 0.000 for an animal the line does not name |
| `recorded_at`, `actor_id` | | NOT NULL | the issue's time and issuer |

A line is **subject to stock** when `available_qty` is below its `base_qty`; a version when any line is (derived, never stored twice).

**As changed in B11u (the owner, 2026-11-23, A-351, A-353, ADR-0098):** a line of animals that names none holds its count at issue, oldest first, capped at what is free, of its weight band when it names one (an animal never weighed is not held for a banded line), so `held_qty` is the animals held and `available_qty` counts only animals of the band; the hold ends with the quote (expiry, a new issued version, a decline, a withdrawal) and passes to the order at conversion. The buyer's `PublicQuoteLine.availableNowQuantity` is read live, never stored: what the quote holds for the line and what is free now, capped at the line's base quantity.

### `quo.quote_line` · DOCUMENT

Frozen with its version.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Referenced by `ord.sales_order_line.quote_line_ref` |
| `quote_version_id` | `uuid` | NOT NULL, FK `quo.quote_version` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NULL, FK `mdm.product` | |
| `description` | `text` | NOT NULL | Free-text requirement for live animals |
| `grade_id` | `uuid` | NULL, FK `mdm.grade` | |
| `weight_band_id` | `uuid` | NULL, FK `mdm.weight_band` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | A particular animal offered |
| `reservation_id` | `uuid` | NULL, FK `inv.stock_reservation` | Held for the quote's validity |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `uom` | `text` | NOT NULL, FK `mdm.uom` | The line's own unit: a crate or a single egg (CR-045) |
| `base_qty` | `qty` | NULL exactly on a free-text line | The quantity in the product's base unit, what is reserved |
| `price_basis` | `text` | NOT NULL, CHECK in (`PER_HEAD`, `PER_KG`, `PER_UNIT`) | |
| `resolved_unit_price_pesewas` | `pesewas` | NULL | What the engine offered for the line's unit, if it resolved; a banded line with no animal is priced at its band (B11u). The list price the converted order line books at (A-350) |
| `resolved_floor_unit_price_pesewas` | `pesewas` | NULL, with the price | The engine's floor: a quoted price below it needs the approval |
| `unit_price_pesewas` | `pesewas` | NOT NULL | The quoted price |
| `line_net_pesewas` | `pesewas` | NOT NULL | |
| `estimated_unit_cost_pesewas` | `pesewas` | NULL | |

- UNIQUE (`quote_version_id`, `line_no`). Written, changed or removed only while the version is a `DRAFT`; the reservation is named once before issue (`ck_quote_line_frozen`).

### `quo.quote_acceptance` · LEDGER

The customer’s acceptance of a quote version.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `quote_version_id` | `uuid` | NOT NULL, UNIQUE, FK `quo.quote_version` | A version is accepted once |
| `method` | `text` | NOT NULL, CHECK in (`SIGNED_LINK`, `IN_PERSON`, `PHONE_CONFIRMED`) | |
| `accepted_name` | `text` | NOT NULL | Who accepted |
| `ip` | `inet` | NULL | For a link acceptance |
| `user_agent` | `text` | NULL | |
| `note` | `text` | NULL; required unless `SIGNED_LINK` (`ck_quote_acceptance_note`) | FR-QUO-010's evidence |
| `accepted_at` | `timestamptz` | NOT NULL | |
| `recorded_at`, `actor_id` | | NOT NULL | |

Standard columns: `LEDGER`. For a link acceptance the actor is the system principal for public endpoints.

### `quo.quote_link_token` · LEDGER

The acceptance links of a version (B10, CR-047, ADR-0074, ADR-0087): one row per token made, by an issue call or a send.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `quote_version_id` | `uuid` | NOT NULL, FK `quo.quote_version`; an `ISSUED` version only | |
| `token_hash` | `bytea` | NOT NULL, UNIQUE, 32 bytes | SHA-256 of the token; the token itself is never stored |
| `recorded_at` | `timestamptz` | NOT NULL | |
| `expires_at` | `timestamptz` | NOT NULL, after `recorded_at`, no later than the version's `valid_until` | |
| `actor_id` | `uuid` | NOT NULL, FK `iam.principal` | |

A version may have several live links (the owner, 2026-11-18, A-324): each opens it while it is live and nobody has revoked it.

### `quo.quote_link_revocation` · LEDGER

One link revoked, with its reason (B10 continued 4, migration 0282, A-324). A revoked link opens nothing (404); the version's other links keep working.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `link_token_id` | `uuid` | NOT NULL, FK `quo.quote_link_token`, UNIQUE (`uq_quote_link_revocation_link`) | revoked once |
| `reason` | `text` | NOT NULL, 1 to 500 characters | |
| `recorded_at` | `timestamptz` | NOT NULL | when it was revoked (the application clock) |
| `actor_id` | `uuid` | NOT NULL, FK `iam.principal` | who revoked it (`quo.quote.issue`) |

### `quo.quote_link_decision` · LEDGER

The acceptance or decline made through a link, with the device and session behind it (B10 continued 4, migration 0282, A-325, abuse case 40). Data category: CONFIDENTIAL (DC-22, DC-27).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `link_token_id` | `uuid` | NOT NULL, FK `quo.quote_link_token`; a link of this version nobody revoked (`quo.quote_link_decision_check`, HK004) | which link decided it |
| `quote_version_id` | `uuid` | NOT NULL, FK `quo.quote_version`, UNIQUE (`uq_quote_link_decision_version`) | decided once across all its links |
| `decision` | `text` | `ACCEPTED`, `DECLINED` | |
| `ip` | `inet` | NULL | the address as the platform resolves it for public calls |
| `user_agent` | `text` | NULL, at most 500 characters | |
| `staff_principal_id` | `uuid` | NULL, FK `iam.principal`; set with `staff_session_id` or neither (`ck_quote_link_decision_staff`); **null on every row since migration 0308** (`ck_quote_link_decision_no_cookie`, NOT VALID: B10 continued 4's rows keep theirs) | whose live staff session the browser also held, read from the staff cookie until the owner withdrew it on 2026-11-23 (A-343) |
| `staff_session_id` | `uuid` | NULL | that session (IAM's id; no foreign key into IAM's session table) |
| `decided_at` | `timestamptz` | NOT NULL | `PublicQuote.decidedAt` for a decline through the link |
| `recorded_at` | `timestamptz` | NOT NULL | |
| `actor_id` | `uuid` | NOT NULL, FK `iam.principal` | the Storefront principal |

### `quo.quote_link_staff_match` · LEDGER

A possible staff acceptance (B10 continued 6, migration 0308, the owner 2026-11-23, A-343, abuse case 40): each staff session IAM saw from a link decision's address in the 24 hours before it, by the application clock, never read from a cookie. It flags; the decision stands. Data category: CONFIDENTIAL (DC-27).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `link_decision_id` | `uuid` | NOT NULL, FK `quo.quote_link_decision`; UNIQUE with `staff_session_id` (`uq_quote_link_staff_match_session`) | the decision matched |
| `staff_principal_id` | `uuid` | NOT NULL, FK `iam.principal` | the staff member named on the flag |
| `staff_session_id` | `uuid` | NOT NULL | IAM's session id; no foreign key into IAM's session table (not a published key) |
| `same_browser` | `boolean` | NOT NULL | the session's user agent (first 500 characters) equals the decision's |
| `session_last_seen_at` | `timestamptz` | NOT NULL | when IAM last saw the session, inside the window |
| `window_hours` | `integer` | NOT NULL, 24 (`ck_quote_link_staff_match_window`) | the window the owner set |
| `recorded_at` | `timestamptz` | NOT NULL | |
| `actor_id` | `uuid` | NOT NULL, FK `iam.principal` | the Storefront principal |
