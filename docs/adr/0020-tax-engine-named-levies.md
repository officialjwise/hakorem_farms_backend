# ADR-0020: Tax is a matrix of named levies per category, each with its own base and reclaimable flag

- **Status:** Accepted for the shape (owner, 2026-11-13). Seed values Proposed until the accountant confirms the real structure before B8
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** owner set the shape; backend track designed the tables

## Context

The shared brief requires tax and levy calculation configurable by product category, with the full breakdown shown on the document, and a configurable tax engine seeded with zero-rated agricultural produce and standard rate on processed meat. Ghana charges value added tax together with separate levies, the levies have at different times been compounding or not and reclaimable or not, and the rules change.

The owner's instruction for this decision: do not build one rate per category. Model several named levies per category, each with its own base and a reclaimable flag, all seeded at zero where they do not apply. The accountant confirms the real structure before B8, and the shape must absorb that without touching billing or the ledger.

## Options considered

1. **One rate per category.** Rejected by the owner. Cannot show a levy breakdown, cannot express a levy with a different base, and cannot mark one levy reclaimable and another not.
2. **Hard-coded VAT, NHIL and GETFund columns.** Shows a breakdown, but a new or abolished levy is a schema change in billing, purchasing and the ledger.
3. **A matrix: named levies as rows of data, a row per category and levy with its own rate, base and reclaimable flag, in effective-dated versions.** Billing and the ledger handle a list of levy amounts and never know which levies exist.

## Decision

Option 3.

**Configuration (MDM module, tax sub-domain)**

| Table | Holds |
| --- | --- |
| `mdm.tax_levy` | A named levy: `code`, `name`, display order. Seeded: `VAT`, `NHIL`, `GETFUND`. A new levy is a new row |
| `mdm.tax_category` | A tax category assigned to products and charges. Seeded: `LIVE_ANIMALS`, `RAW_PRODUCE`, `EGGS`, `PROCESSED_MEAT`, `FARM_INPUTS`, `DELIVERY_SERVICE`, `OTHER_GOODS` |
| `mdm.tax_scheme_version` | An effective-dated version of the whole matrix. Drafted, approved by a second user, then activated; immutable once active. Versions cannot overlap in time |
| `mdm.tax_category_levy` | One row per version, category and levy: `treatment` (`STANDARD`, `ZERO_RATED`, `EXEMPT`, `OUT_OF_SCOPE`), `rate_percent NUMERIC(7,4)`, `base_kind` (`NET` or `NET_PLUS_LEVIES`), `is_reclaimable`, `calc_order` |
| `mdm.tax_levy_base_component` | For a `NET_PLUS_LEVIES` row, which other levies' amounts are added to its base. A component must have a lower `calc_order`, so the definition cannot be circular |

A version can be activated only if it contains a row for every category and every levy. Where a levy does not apply to a category the row exists with rate zero and the appropriate treatment. There is no "missing means zero".

A business setting, `tax.registered`, with an effective date, switches charging off entirely for a business that is not registered: no levy is charged on sales and no input levy is reclaimable.

**Calculation (one pure calculator, in MDM, used by quotes, carts, orders, billing and purchasing)**

For a line with category `c` on date `d`, take the levies of the active version in `calc_order`. `r_i` is the rate of levy `i`.

- *Tax-exclusive price.* The anchor is the line net (ADR-0001). For each levy in order: `base_i = net + sum of the amounts of its base components`, `amount_i = half_up(base_i × r_i)`. Gross is net plus the amounts.
- *Tax-inclusive price.* The anchor is the line gross. Each levy's effective rate relative to net is `e_i = r_i × (1 + sum of e_j for its base components)`, computed exactly. The gross is split across net and the levies by `allocate` with weights `1 : e_1 : … : e_n`, so the parts sum to the gross exactly.
- A row is produced for every levy, including those at zero, so a document can state that a line is zero-rated or exempt.

**Billing (BIL module)**

- `bil.billing_document_line_tax` stores one row per line and levy: the levy, its code and name as printed, treatment, rate, base and amount, plus the scheme version used. These are snapshots and never change.
- Document tax totals are sums of those rows. Templates print the breakdown by iterating over them.
- The document carries optional certified-total fields, for the case where an electronic invoicing service returns totals that differ by a pesewa from line sums.

**Purchasing (PUR module)**

- `pur.supplier_invoice_line_tax` stores the same rows for supplier invoices, with `is_reclaimable` snapshotted.
- A reclaimable levy is posted to the recoverable account. A non-reclaimable levy is part of the cost of what was bought.

**Ledger (FIN module)**

- Output levies post to account 2100 and reclaimable input levies to account 1400. Both are control accounts whose subledger is the levy (ADR-0003).
- The event from billing or purchasing carries a list of `{ levy_id, amount_pesewas }`. The posting rule posts each to the control account with that levy as subledger.
- `fin.account_determination` can map a particular levy to a different account if the accountant wants one, by adding a row.

**What a change costs**

| Change | What is touched |
| --- | --- |
| A rate changes | A new tax scheme version |
| A levy is added or abolished | A `tax_levy` row and a new version |
| A levy becomes compounding, or stops | `base_kind` and components in a new version |
| A levy becomes reclaimable, or stops | `is_reclaimable` in a new version |
| A category moves from zero-rated to exempt | `treatment` in a new version |
| The accountant wants a levy on its own account | A `fin.account_determination` row |

None of these touches billing code, ledger code, or any table definition.

**Proposed seed, pending the accountant**

| Category | Treatment | VAT | NHIL | GETFund |
| --- | --- | --- | --- | --- |
| `LIVE_ANIMALS`, `RAW_PRODUCE`, `EGGS` | `ZERO_RATED` | 0 | 0 | 0 |
| `PROCESSED_MEAT`, `OTHER_GOODS`, `DELIVERY_SERVICE` | `STANDARD` | 15 | 2.5 | 2.5 |
| `FARM_INPUTS` | `ZERO_RATED` | 0 | 0 | 0 |

All bases `NET`, all levies reclaimable. The standard rates are those reported on the Ghana Revenue Authority's website on 2026-11-13 for the regime in force from 1 January 2026. They have not been verified against primary sources by this project. B1 records the verification, with source and date, in `docs/security/COMPLIANCE.md`. Whether raw produce and live animals are zero-rated or exempt is the open point for the accountant; it changes only the `treatment` and `is_reclaimable` cells.

## Consequences

- The accountant's answer before B8 is entered as data. If it arrives after B4 has seeded the proposed values, it is a new scheme version.
- A levy charged as a fixed amount per unit, rather than a percentage, is not expressible. It is parked in `docs/BACKLOG.md`.
- Every line carries a few tax rows even when all are zero. This is accepted for the sake of a complete statutory breakdown.
- Changing tax configuration is a maker-checker action with step-up authentication (ADR-0017).
- Binds: `docs/data-model/mdm.md`, `docs/data-model/bil.md`, `docs/data-model/pur.md`, `docs/data-model/fin.md`, the `hakorem-money` and `hakorem-documents` skills.

## Verification

- B4: calculator tests with exact values for exclusive and inclusive prices, a compounding levy, a zero-rated and an exempt category, and a rounding edge case; a test that an incomplete version cannot be activated.
- B8: a test that adds a fourth levy as data only, issues an invoice and asserts the document shows four levy lines and the ledger has four subledger postings, with no code change.
- B8: inclusive-price lines always satisfy net plus levies equals gross.
