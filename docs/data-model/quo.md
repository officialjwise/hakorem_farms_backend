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
| `needed_by` | `date` | NULL | |
| `delivery_area` | `text` | NULL | |
| `assigned_to` | `uuid` | NULL, FK `iam.principal` | Salesperson |
| `submitted_ip` | `inet` | NULL | Rate limiting and abuse review for the public form |

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
| `decline_reason` | `text` | NULL | |

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
| `tax_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Estimate from the tax calculator |
| `gross_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `estimated_cost_pesewas` | `pesewas` | NULL | For margin |
| `margin_percent` | `percent` | NULL | |
| `below_margin_floor` | `boolean` | NOT NULL DEFAULT `false` | |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required to issue when `below_margin_floor` | |
| `change_note` | `text` | NULL | What changed from the previous version |
| `acceptance_token_hash` | `bytea` | NULL | Hash of the token in the signed acceptance link |
| `issued_at` | `timestamptz` | NULL | |
| `issued_by` | `uuid` | NULL, FK `iam.principal` | |
| `archived_document_id` | `uuid` | NULL, FK `doc.archived_document` | The PDF sent |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `created_by` | `uuid` | NOT NULL, FK `iam.principal` | |

- UNIQUE (`quote_id`, `version_no`). Issuing a version sets earlier issued versions to `SUPERSEDED`.

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
| `uom` | `text` | NOT NULL, FK `mdm.uom` | |
| `price_basis` | `text` | NOT NULL, CHECK in (`PER_HEAD`, `PER_KG`, `PER_UNIT`) | |
| `resolved_unit_price_pesewas` | `pesewas` | NULL | What the engine offered, if it resolved |
| `unit_price_pesewas` | `pesewas` | NOT NULL | The quoted price |
| `line_net_pesewas` | `pesewas` | NOT NULL | |
| `estimated_unit_cost_pesewas` | `pesewas` | NULL | |

- UNIQUE (`quote_version_id`, `line_no`).

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
| `accepted_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`. For a link acceptance the actor is the system principal for public endpoints.
