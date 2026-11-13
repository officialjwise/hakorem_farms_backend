# HaKorem Farms Platform: Assumptions

Every assumption made in place of an answer, dated, with who needs to confirm it and by when. An assumption stays here until it is confirmed (and the status says by whom) or replaced by a decision in an ADR.

Statuses: **Open** (nobody has confirmed it), **Confirmed** (the named person agreed), **Replaced** (an ADR or a later answer supersedes it).

"Needed before" is the build session that cannot finish correctly without the answer.

## Owner's answers recorded on 2026-11-13

The owner answered the open questions in the shared brief with "everything else on the brief's defaults", and approved three flagged items with conditions. These are recorded as confirmed.

| ID | Assumption | In place of | Confirmed by | Status |
| --- | --- | --- | --- | --- |
| A-001 | Build multi-location from day one and run a single location | Number of locations at launch | Owner | Confirmed |
| A-002 | Investors hold equity in units; profit retention is 40 percent and owner-configurable | Number of investors, equity or loan, retention rate | Owner | Confirmed |
| A-003 | Live animals are not bought directly online. The storefront takes a request to buy, which becomes a quote | Whether live animals are sold online | Owner | Confirmed |
| A-004 | The business holds one mobile money account and one bank account. Cash on delivery is live at launch with driver reconciliation | Accounts held; cash on delivery | Owner | Confirmed |
| A-005 | No existing records are migrated. The accountant enters an opening balance journal on day one | Records to migrate, opening balances | Owner | Confirmed |
| A-006 | Domain `hakoremfarms.com`: storefront on the apex, console on `app.`, API on `api.` | Domain and subdomains | Owner | Confirmed |
| A-007 | A staging server on the smallest plan exists from the start | Staging from the start | Owner | Confirmed |
| A-008 | The order core is built at the start of B9, and B9 is two sessions: B9a order core and payments, B9b point of sale, shifts and offline sync (ADR-0026) | The schedule as written | Owner | Confirmed |
| A-009 | Investor distributions are allocated by unit-days, with largest-remainder rounding on integer pesewas. The contribution day counts; the withdrawal day does not; actual calendar days in Africa/Accra (ADR-0028) | The meaning of "weighted average shareholding" | Owner | Confirmed |
| A-010 | Tax is modelled as several named levies per category, each with its own base and reclaimable flag, seeded at zero where a levy does not apply. Produce, live animals and eggs are seeded zero-rated (ADR-0020) | VAT status and which levies apply | Owner, for the shape and the seed | Confirmed |

## Open: for the accountant

| ID | Date | Assumption | Needs confirming by | Needed before | Status |
| --- | --- | --- | --- | --- | --- |
| A-020 | 2026-11-13 | The tax structure: which levies exist, their bases, which are reclaimable, and the treatment of each product category. Confirmed by the owner on 2026-11-13 as modelled in ADR-0020 (raw produce, live animals and eggs zero-rated; processed meat standard-rated), except the two points in A-033 and A-034 | Owner (confirmed); accountant for A-033 and A-034 | B8 | Confirmed |
| A-021 | 2026-11-13 | Standard rates of VAT 15 percent, NHIL 2.5 percent and GETFund 2.5 percent on one base, no compounding, no COVID-19 levy, for the regime from 1 January 2026. Confirmed by the owner on 2026-11-13 as correct against the VAT Act 2025 regime; recorded in `docs/security/COMPLIANCE.md` | Owner | B8 | Confirmed |
| A-022 | 2026-11-13 | Whether the business is registered for VAT. Replaced by A-033, which asks the prior question of the threshold | Accountant | B8 | Replaced |
| A-023 | 2026-11-13 | Retail and online price lists are tax-inclusive; wholesale lists are tax-exclusive. It is a flag per price list | Accountant and owner | B4 | Open |
| A-024 | 2026-11-13 | Livestock is carried at accumulated cost, not fair value | Accountant | B8 | Open |
| A-025 | 2026-11-13 | Animals born on the farm enter at nil cost. Feed and veterinary cost is capitalised onto growing stock and expensed for breeding stock | Accountant | B6 | Open |
| A-026 | 2026-11-13 | Eggs and harvested produce are received at a standard cost per unit set by the owner, default zero | Accountant | B6 | Open |
| A-027 | 2026-11-13 | A difference between a supplier's invoice and the receipt value is posted to a purchase price variance account, not back onto the stock | Accountant | B8 | Open |
| A-028 | 2026-11-13 | The fiscal year is the calendar year, with twelve monthly periods | Accountant | B8 | Open |
| A-029 | 2026-11-13 | The seeded chart of accounts and the event-to-posting matrix in ADR-0003 | Accountant | B8 | Open |
| A-030 | 2026-11-13 | Tax withheld on investor distributions defaults to zero | Accountant | B12 | Open |
| A-031 | 2026-11-13 | Units are issued at GHS 1.00 per unit unless the owner sets another price for a transaction | Owner and accountant | B12 | Open |
| A-032 | 2026-11-13 | One legal entity and one set of books. Branch is a dimension, not a company | Owner and accountant | B8 | Open |
| A-033 | 2026-11-13 | Whether the business is above the GHS 750,000 VAT registration threshold at all. If it is not, the setting `tax.registered` is false from its effective date: no levy is charged on sales and none is reclaimed on purchases, and billing documents carry no levy lines. No code changes either way | Accountant (raised by the owner, 2026-11-13) | B8 | Open |
| A-034 | 2026-11-13 | Whether imported farm inputs still cascade where domestic supply does not. If they do, a tax category for imported inputs is added with its own levy cells (non-reclaimable, or with a NET_PLUS_LEVIES base), as data in a new tax scheme version (ADR-0020). No billing or ledger change | Accountant (raised by the owner, 2026-11-13) | B7 | Open |
| A-035 | 2026-11-13 | Customers appointed as VAT withholding agents (GRA: 7 percent with a certificate) would pay wholesale invoices short. No payment treatment or receivable account exists for withheld VAT yet; if any customer is such an agent, a withholding receivable and a payment allocation for the certificate are added in B9a | Accountant | B9a | Open |
| A-036 | 2026-11-13 | Some insert-only tables hold personal data in clear (`del.proof_of_delivery` recipient name and position, `quo.quote_acceptance`, `platform.audit_event` IP and user agent, `platform.file_access_log` IP, `doc.archived_document.render_data`), which a deletion request or retention job cannot erase. Needs an ADR extending ADR-0022 (encrypt under the subject key, or classify as retained with the legal basis) | Backend lead, owner to approve | B3 | Open |
| A-037 | 2026-11-13 | Restoring an older backup brings back subject keys destroyed since, undoing deletion requests. Proposed (`docs/security/DATA_CLASSIFICATION.md`, limit L-2): each daily audit anchor also records destroyed key ids, and restore re-applies them. To be confirmed by an amendment of ADR-0022 and the restore runbook | Backend lead | B3 | Open |
| A-038 | 2026-11-13 | ADR-0016 lets a cashier unlock an offline till with a PIN, but no table stores a PIN verifier. B9b adds it (hashed, per cashier, cached in the offline pack) | Backend lead | B9b | Open |
| A-039 | 2026-11-13 | If E-VAT certification applies (A-062), each invoice and receipt needs a certification call returning a QR code and signature to print. That call cannot run inside the issuing transaction (ADR-0010) and does not fit offline provisional receipts as designed (ADR-0015). Needs an ADR before B8 | Backend lead, accountant | B8 | Open |
| A-050 | 2026-11-13 | Retention periods that are not statutory are design defaults set in `aud.retention_policy` (customer inactivity 36 months, message bodies 12 months, logs 13 months, idempotency keys 7 days, carts 30 days, closed requests for quote 24 months), as are signed-URL lifetimes (15 minutes confidential, 5 minutes restricted) and a 72-hour internal breach-notification target | Owner | B13 | Open |

## Open: for the owner

| ID | Date | Assumption | Needs confirming by | Needed before | Status |
| --- | --- | --- | --- | --- | --- |
| A-040 | 2026-11-13 | Three further schedule assignments proposed in ADR-0026: online store split across B7, B9a and B11; retention and data-subject requests in B13; the daily exception report in B12. Not addressed in the owner's gate notes of 2026-11-13; B1 proceeds on them as proposed | Owner | B7 | Open |
| A-041 | 2026-11-13 | Offline, the counter takes cash only. Mobile money cannot be verified without a connection. A setting can allow a manager-approved unverified mobile money tender | Owner | B9b | Open |
| A-042 | 2026-11-13 | At least two people hold approving roles at each branch, so that maker and checker can always differ | Owner | B3 | Open |
| A-043 | 2026-11-13 | Approval thresholds (mortality value, adjustment value, refund, price override, purchase order) are settings whose starting values the owner sets before go-live. Seeds use illustrative values clearly marked as seed | Owner | B13 | Open |
| A-044 | 2026-11-13 | Catch-weight tolerance defaults to 10 percent per product | Owner | B9a | Open |
| A-045 | 2026-11-13 | An online checkout holds stock for 15 minutes while payment is awaited | Owner | B7 | Open |
| A-046 | 2026-11-13 | A veterinary withdrawal hold cannot be released early by anyone | Owner and vet | B6 | Open |
| A-047 | 2026-11-13 | Paystack is the first payment adapter. A second aggregator is not built in version one; the port allows one to be added | Owner | B3 | Open |
| A-048 | 2026-11-13 | Receipts by SMS and WhatsApp for counter sales begin when the notification module lands in B11. From B9b the counter prints thermal receipts | Owner | B9b | Open |
| A-049 | 2026-11-13 | A second branch flagged as test exists in every environment, including production, for the deployment smoke suite | Owner | B13 | Open |

## Open: to be verified by the build

| ID | Date | Assumption | Verified by | Needed before | Status |
| --- | --- | --- | --- | --- | --- |
| A-060 | 2026-11-13 | In PostgreSQL 17, a session-level advisory lock taken before `BEGIN` makes a second serializable transaction wait and then succeed, whereas `SELECT pg_advisory_xact_lock(...)` as the first statement inside the transaction does not, because that statement takes the snapshot before it blocks (ADR-0005) | A two-session test | B2 | Open |
| A-061 | 2026-11-13 | A receipt printed offline with a provisional reference, followed by an official number at sync, is acceptable to the Ghana Revenue Authority (ADR-0015). Checked on 2026-11-13: no source confirms it. GRA guidance says a taxpayer whose system goes offline tells GRA within 24 hours and uploads the offline transactions afterwards, and that certified E-VAT software can issue receipts offline for 24 hours (`docs/security/COMPLIANCE.md`). Still open | Accountant, then GRA | B9b | Open |
| A-062 | 2026-11-13 | Whether electronic invoice certification applies, and whether it totals tax at document level. Checked on 2026-11-13: GRA's guideline requires registered taxpayers to issue invoices and receipts through the certified system, subject to GRA's phasing; document-level totalling is not answered publicly (it is in the API documentation GRA supplies at onboarding). Applies if A-033 finds the business registered | Accountant | B8 | Open |
| A-063 | 2026-11-13 | Ghana's Data Protection Act permits retaining invoices and receipts for the statutory period despite a deletion request. Checked on 2026-11-13: supported by Act 843 sections 24(1)(a) and 33(1)(b); retention of tax records is at least six years (E-VAT guideline, Electronic Transactions Act 2008 s.8(2), Revenue Administration Act 2016 s.27 from secondary sources). Policy set at 84 months | Accountant | B13 | Confirmed by sources |
| A-064 | 2026-11-13 | The first payment adapter supports pre-authorisation and later capture for cards. Mobile money does not, so the estimate is charged and the difference settled (ADR-0021) | Provider documentation and a sandbox test | B9a | Open |
| A-065 | 2026-11-13 | Token lifetimes in ADR-0016 are design defaults. The staff refresh lifetime must cover an eight-hour offline shift | Set and recorded in the session report | B3 | Open |
| A-066 | 2026-11-13 | Argon2id parameters are tuned to about 250 ms on the production server | Measurement on the server | B3, confirmed B13 | Open |
| A-067 | 2026-11-13 | The object storage provider is chosen at provisioning. MinIO is used in development and CI | Recorded in `docs/OPERATIONS.md` | B13 | Open |
| A-068 | 2026-11-13 | No table needs partitioning at year-one volumes | The seeded performance dataset and load test | B13 | Open |
| A-069 | 2026-11-13 | The hosting plan's disk can be encrypted, or the risk is accepted with column encryption and encrypted backups as the controls | Checked at provisioning | B13 | Open |

## Notes for the frontend track

These follow from backend decisions and affect what the frontend builds. They are repeated in the B0 session report.

| ID | Note |
| --- | --- |
| F-001 | Session cookies are bound to the API host. Storefront pages that need the customer's identity fetch that data in the browser; server-rendered catalogue pages are anonymous (ADR-0016) |
| F-002 | Every state-changing request sends an `Idempotency-Key` and an `X-CSRF-Token` (ADR-0014, ADR-0016) |
| F-003 | Offline sales carry a client-generated UUIDv7, a device counter and a provisional reference, and are cash only by default (ADR-0015, ADR-0027) |
| F-004 | Checkout must show the estimated total, the maximum total and the final-charge rule for catch-weight items (ADR-0021) |
| F-005 | A product in `REQUEST_TO_BUY` mode opens a request for quote instead of adding to the cart (ADR-0019) |
| F-006 | A price that does not resolve is a "quote required" result, not an error (ADR-0004) |
| F-007 | Slot 10 is two backend sessions, B9a then B9b. F9 is unchanged (ADR-0026) |
