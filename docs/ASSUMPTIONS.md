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
| A-031 | 2026-11-13 | Units are issued at GHS 100.00 per unit (10,000 pesewas) unless the owner sets another price for a transaction. Changed in B1 from GHS 1.00 to match the contract examples and UAT | Owner and accountant | B12 | Open |
| A-032 | 2026-11-13 | One legal entity and one set of books. Branch is a dimension, not a company | Owner and accountant | B8 | Open |
| A-033 | 2026-11-13 | Whether the business is above the GHS 750,000 VAT registration threshold at all. If it is not, the setting `tax.registered` is false from its effective date: no levy is charged on sales and none is reclaimed on purchases, and billing documents carry no levy lines. No code changes either way | Accountant (raised by the owner, 2026-11-13) | B8 | Open |
| A-034 | 2026-11-13 | Whether imported farm inputs still cascade where domestic supply does not. If they do, a tax category for imported inputs is added with its own levy cells (non-reclaimable, or with a NET_PLUS_LEVIES base), as data in a new tax scheme version (ADR-0020). No billing or ledger change | Accountant (raised by the owner, 2026-11-13) | B7 | Open |
| A-035 | 2026-11-13 | Customers appointed as VAT withholding agents (GRA: 7 percent with a certificate) would pay wholesale invoices short. No payment treatment or receivable account exists for withheld VAT yet; if any customer is such an agent, a withholding receivable and a payment allocation for the certificate are added in B9a | Accountant | B9a | Open |
| A-036 | 2026-11-13 | Some insert-only tables hold personal data in clear (`del.proof_of_delivery` recipient name and position, `quo.quote_acceptance`, `platform.audit_event` IP and user agent, `platform.file_access_log` IP, `doc.archived_document.render_data`), which a deletion request or retention job cannot erase. Needs an ADR extending ADR-0022 (encrypt under the subject key, or classify as retained with the legal basis). The owner agreed on 2026-11-13 that the ADR is written in B3 | Backend lead, owner to approve | B3 | Open |
| A-037 | 2026-11-13 | Restoring an older backup brings back subject keys destroyed since, undoing deletion requests. Proposed (`docs/security/DATA_CLASSIFICATION.md`, limit L-2): each daily audit anchor also records destroyed key ids, and restore re-applies them. To be confirmed by an amendment of ADR-0022 and the restore runbook | Backend lead | B3 | Open |
| A-038 | 2026-11-13 | ADR-0016 lets a cashier unlock an offline till with a PIN, but no table stores a PIN verifier. B9b adds it (hashed, per cashier, cached in the offline pack) | Backend lead | B9b | Open |
| A-039 | 2026-11-13 | If E-VAT certification applies (A-062), each invoice and receipt needs a certification call returning a QR code and signature to print. That call cannot run inside the issuing transaction (ADR-0010) and does not fit offline provisional receipts as designed (ADR-0015). Needs an ADR before B8; the owner agreed this timing on 2026-11-13. Held open for the accountant | Backend lead, accountant | B8 | Open |
| A-050 | 2026-11-13 | Retention periods that are not statutory are design defaults set in `aud.retention_policy` (customer inactivity 36 months, message bodies 12 months, logs 13 months, idempotency keys 7 days, carts 30 days, closed requests for quote 24 months), as are signed-URL lifetimes (15 minutes confidential, 5 minutes restricted) and a 72-hour internal breach-notification target | Owner | B13 | Open |
| A-051 | 2026-11-13 | A customer's deposit does not reduce credit exposure until it is allocated to an invoice (as the contract's credit-override example implies). UAT scenario 2 tests this | Owner and accountant | B10 | Open |
| A-052 | 2026-11-13 | On a partly dispatched order, the delivery fee is billed with the first dispatch | Owner | B11 | Open |
| A-053 | 2026-11-13 | No user may grant a role to themselves. A holder of `iam.grant.manage` may grant roles to others with step-up; every grant is audited and appears on the daily exception report as PERMISSION_CHANGE | Owner | B3 | Open |
| A-054 | 2026-11-13 | Abuse cases 5, 10 and 15 and the restore drill (UAT scenarios 5 and 7) need a technical person to stage. B13 provides a drill page for staging them on staging so a non-developer can run the checks | Owner | B13 | Open |
| A-055 | 2026-11-13 | The seed baseline in `docs/UAT.md` section 3 (goats, egg stock, open purchase order, credit limits, users, Q3 2026 net profit of GHS 41,666.70, the illustrative approval limits under A-043) is what the seed script reaches by B12; each module session extends it | Backend lead | B4 | Open |
| A-056 | 2026-11-13 | The quarterly restore drill restores production backups into an isolated temporary database on the staging server, destroyed after the drill, so production data never enters staging itself (`docs/OPERATIONS.md` 9.5) | Owner | B13 | Open |
| A-057 | 2026-11-13 | The deployment needs containers ADR-0025 does not list: a malware scanner (ClamAV) for uploads, Alertmanager and Prometheus exporters; traces go to Sentry. The scanner is needed from B3, when uploads start | Backend lead | B3 | Open |
| A-058 | 2026-11-13 | An offline sale posted on a later date than it happened carries a "posted late" flag on the order, and the over or short of a force-closed shift posts through the shift close event once its count is entered. Both are added to `docs/data-model/ord.md` and ADR-0003's matrix in B9b | Backend lead | B9b | Open |
| A-059 | 2026-11-13 | Opening fixed assets come in at net book value; opening receivables and payables as opening-journal lines settled by hand; an opening capital contribution posts on the opening date while its value date governs units (`docs/DATA_MIGRATION.md`) | Accountant | B8 | Open |

## Open: for the owner

| ID | Date | Assumption | Needs confirming by | Needed before | Status |
| --- | --- | --- | --- | --- | --- |
| A-040 | 2026-11-13 | Three further schedule assignments in ADR-0026: online store split across B7 (catalogue, cart, checkout reservation), B9a (order placement, online payment) and B11 (abandoned-cart messaging); retention and data-subject requests in B13; the daily exception report in B12. Confirmed by the owner on 2026-11-13, after the B1 gate, exactly as proposed, with no changes | Owner (confirmed) | B7 | Confirmed |
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
| A-060 | 2026-11-13 | In PostgreSQL 17, a session-level advisory lock taken before `BEGIN` makes a second serializable transaction wait and then succeed, whereas `SELECT pg_advisory_xact_lock(...)` as the first statement inside the transaction does not, because that statement takes the snapshot before it blocks (ADR-0005) | A two-session test | B2 | Confirmed by test, B2, 2026-11-14: `test/integration/platform/advisory-lock.integration.spec.ts` passes both halves on PostgreSQL 17.6 (the second transaction waits and succeeds; with `pg_advisory_xact_lock` first it fails with 40001) |
| A-061 | 2026-11-13 | A receipt printed offline with a provisional reference, followed by an official number at sync, is acceptable to the Ghana Revenue Authority (ADR-0015). Checked on 2026-11-13: no source confirms it. GRA guidance says a taxpayer whose system goes offline tells GRA within 24 hours and uploads the offline transactions afterwards, and that certified E-VAT software can issue receipts offline for 24 hours (`docs/security/COMPLIANCE.md`). Still open | Accountant, then GRA | B9b | Open |
| A-062 | 2026-11-13 | Whether electronic invoice certification applies, and whether it totals tax at document level. Checked on 2026-11-13: GRA's guideline requires registered taxpayers to issue invoices and receipts through the certified system, subject to GRA's phasing; document-level totalling is not answered publicly (it is in the API documentation GRA supplies at onboarding). Applies if A-033 finds the business registered | Accountant | B8 | Open |
| A-063 | 2026-11-13 | Ghana's Data Protection Act permits retaining invoices and receipts for the statutory period despite a deletion request. Checked on 2026-11-13: supported by Act 843 sections 24(1)(a) and 33(1)(b); retention of tax records is at least six years (E-VAT guideline, Electronic Transactions Act 2008 s.8(2), Revenue Administration Act 2016 s.27 from secondary sources). Policy set at 84 months | Accountant | B13 | Confirmed by sources |
| A-064 | 2026-11-13 | The first payment adapter supports pre-authorisation and later capture for cards. Mobile money does not, so the estimate is charged and the difference settled (ADR-0021) | Provider documentation and a sandbox test | B9a | Open |
| A-065 | 2026-11-13 | Token lifetimes in ADR-0016 are design defaults. The staff refresh lifetime must cover an eight-hour offline shift | Set and recorded in the session report | B3 | Open |
| A-066 | 2026-11-13 | Argon2id parameters are tuned to about 250 ms on the production server | Measurement on the server | B3, confirmed B13 | Open |
| A-067 | 2026-11-13 | The object storage provider is chosen at provisioning. MinIO is used in development and CI | Recorded in `docs/OPERATIONS.md` | B13 | Open |
| A-068 | 2026-11-13 | No table needs partitioning at year-one volumes | The seeded performance dataset and load test | B13 | Open |
| A-069 | 2026-11-13 | The hosting plan's disk can be encrypted, or the risk is accepted with column encryption and encrypted backups as the controls | Checked at provisioning | B13 | Open |
| A-070 | 2026-11-14 | MinIO no longer publishes container images (no tag of `minio/minio` or `quay.io/minio/minio` can be pulled), so the development and CI object store named in A-067 needs another S3-compatible server. B2 needs no object storage, so its stack is PostgreSQL and Redis only. B3 chooses the replacement and records it | B3 session, by ADR | B3 | Open |
| A-071 | 2026-11-14 | `pnpm setup` is a built-in pnpm command (it edits shell start-up files) and cannot run a package script, so the one-command setup is `pnpm run setup` (or `bash scripts/setup.sh`). `CLAUDE.md`, `docs/ONBOARDING.md` and `docs/BUILD_PROMPT.md` now say so | Owner | B2 | Open |
| A-072 | 2026-11-14 | Until B3, `GET /v1/health` reports the database and Redis only, because the outbox, audit sealing, WAL archiving and reconciliation do not exist yet. The response matches the contract's `Health` schema; each later mechanism adds its own check | B3 session | B3 | Open |
| A-073 | 2026-11-14 | `pnpm run setup` refuses below 1.5 GB of Docker memory and warns below the 6 GB `docs/ONBOARDING.md` recommends, because PostgreSQL, Redis and the API run in 2 GB today and a hard 6 GB floor would refuse working machines | Owner | B2 | Open |
| A-074 | 2026-11-14 | The error codes `docs/API.md` marks "Added" are adopted by each operation when its code is written, not by hand across the planned contract in B2 (ADR-0030) | Owner | B3 onward | Open |
| A-075 | 2026-11-14 | `pnpm db:seed` exists with its three production refusals (`APP_ENV`, `SEED_ALLOWED`, and the environment marked on the database) but has no seed units: B2 has no module tables. The seeded farm grows from B3 | Owner | B3 onward | Open |
| A-076 | 2026-11-14 | `multer` 2.5.0 and `handlebars` 4.7.10 are pinned by pnpm overrides to clear high and critical advisories, because the NestJS release that carries the multer fix is younger than the 14-day release-age floor. Remove the multer override when `@nestjs/platform-express` 11.2.10 or later passes the floor | B3 session | B3 | Open |
| A-077 | 2026-11-14 | The 16 secret-scan findings in the B0 and B1 history are documentation examples (a truncated PEM marker, example tokens and login passwords, a key named `EXAMPLE-NOT-A-REAL-KEY`, UUIDs), plus two earlier versions of those examples (`hk_live_…` and `whsec_…`, this platform's own formats, never issued by any system). Each example value, not its file, is allowlisted in `.gitleaks.toml`, so any other secret still fails the scan | Owner | B2 | Open |
| A-078 | 2026-11-14 | Pull requests 1 (B0) and 2 (B1) are not merged, so B2's branch is stacked on B1's and its pull request targets `b01-documents-contract` | Owner, by merging | B2 | Open |
| A-079 | 2026-11-14 | Backend sessions opened at the workspace root, as the session openers say, do not load the sixteen skills in `backend/.claude/skills/`; sessions opened in `backend/` do (`docs/prompts/SKILLS_VERIFICATION.md`, Run 2). The openers are unchanged until the owner chooses where sessions open | Owner | B3 | Open |


## Open: settings and definitions introduced by the SRS

Written in B1 with `docs/SRS.md` section 7.4, which cites them by these ids. Each is a setting or a definition: changing it changes data, not code.

| ID | Date | Assumption | Needs confirming by | Needed before | Status |
| --- | --- | --- | --- | --- | --- |
| SA-01 | 2026-11-13 | Login lockout after 5 consecutive failures; lock 1 minute, doubling per further failure, capped at 60 minutes (used by FR-IAM-017) | Owner | B3 | Open |
| SA-02 | 2026-11-13 | A bulk export is more than 1,000 rows and needs step-up (as the contract's `rpt.report.export.bulk` permission states) (used by FR-MDM-020, FR-RPT-005, SEC-009) | Owner | B4 | Open |
| SA-03 | 2026-11-13 | Webhook timestamp window of 5 minutes either side (used by FR-PAY-004, SEC-005) | Backend lead | B9a | Open |
| SA-04 | 2026-11-13 | Signed URLs for private files live 15 minutes for confidential files and 5 minutes for restricted ones (`docs/security/DATA_CLASSIFICATION.md`, A-050) (used by FR-DOC-007) | Backend lead | B8 | Open |
| SA-05 | 2026-11-13 | An account goes on hold when any invoice is more than 30 days past due (used by FR-WHL-008) | Owner | B10 | Open |
| SA-06 | 2026-11-13 | Quote validity 14 days; margin floor 10 percent over cost (used by FR-QUO-004, FR-QUO-005) | Owner | B10 | Open |
| SA-07 | 2026-11-13 | Yield variance flag when actual differs from expected by more than 5 percent of expected (used by FR-PRC-005) | Owner | B6 | Open |
| SA-08 | 2026-11-13 | Three-way match tolerance: price 1 percent, quantity zero beyond the receipt (used by FR-PUR-009) | Accountant | B7 | Open |
| SA-09 | 2026-11-13 | Quiet hours 21:00 to 07:00 Africa/Accra; security codes and delivery-day messages exempt (used by FR-NTF-006) | Owner | B11 | Open |
| SA-10 | 2026-11-13 | Webhook delivery: 8 attempts, exponential backoff from 1 minute with jitter, capped at 6 hours (used by FR-API-009) | Backend lead | B12 | Open |
| SA-11 | 2026-11-13 | Upload caps: images 5 MB; PDF and spreadsheets 10 MB (used by FR-DOC-006) | Backend lead | B8 | Open |
| SA-12 | 2026-11-13 | Default page size 25, maximum 100, as the contract's `PageLimit` (used by FR-API-003) | Backend lead | B12 | Open |
| SA-13 | 2026-11-13 | Delivery is split in two. Delivery zones and fees are master data and land in B4 (FR-MDM-010, `mdm.delivery_zone`). B7 creates `del.delivery_slot` and slot generation, and its checkout accepts a slot without enforcing capacity, which is enough for its gate. Slot capacity, cut-offs and scheduling stay in B11 (FR-DEL-001 to FR-DEL-003, FR-SHP-009). Recorded in ADR-0026; F7 builds the slot picker against the contract mock (used by FR-SHP-008, FR-SHP-009) | Owner, 2026-11-13 | B7 | Confirmed |
| SA-14 | 2026-11-13 | IRR uses the investor's share of total equity at the as-at date as closing value, actual/365; ROI is distributions paid over net contributions (used by FR-CAP-014) | Accountant | B12 | Open |
| SA-15 | 2026-11-13 | Seed rate limits: login 10 per minute per address and per account; password reset 5 per hour per account; quote request 5 per hour per address and per phone; checkout 10 per minute per address; API key 60 per minute unless set. All are settings recorded in `docs/OPERATIONS.md` (SECURITY_ARCHITECTURE section 5) (used by SEC-026, FR-QUO-001, FR-SHP-010, FR-API-007) | Backend lead | B7 | Open |
| SA-16 | 2026-11-13 | Application and security logs are kept 365 days (used by SEC-033) | Owner | B13 | Open |
| SA-17 | 2026-11-13 | Exception report thresholds: a price-override item once a user reaches 80 percent of the shift limit; an unverified tender pending 15 minutes; a handler's mortality rate over twice the pen average in 30 days; refunds in a day over 3 times the branch average; 1,000 exported rows in a day; an adjustment within 7 days before a stock take of the location; 5 authorisation refusals by one principal in an hour; a supplier payment within 24 hours after a payout detail change (used by SEC-002, SEC-003, SEC-004, SEC-007, SEC-008, SEC-009, SEC-012, SEC-013) | Owner | B13 | Open |
| SA-18 | 2026-11-13 | Retention and subject-request seeds: notification bodies 12 months, carts and expired checkouts 30 days (as A-050), subject export within 30 days; statutory documents follow A-063 (used by FR-AUD-009, FR-AUD-010) | Owner, after the compliance check | B3 | Open |
| SA-19 | 2026-11-13 | Operational seeds: expiring-stock alert 3 days before expiry; storefront availability `LOW` at 5 or fewer; gestation days goat 150, sheep 147, pig 114, rabbit 31 (used by FR-INV-016, FR-SHP-002, FR-LIV-010) | Owner and vet | B5 | Open |
| SA-20 | 2026-11-13 | Customer phone verification: 6-digit code, 10 minutes, 5 attempts; password reset token 30 minutes; password minimum 12 characters (used by FR-IAM-005, FR-IAM-019, FR-IAM-020) | Backend lead | B3 | Open |
| SA-21 | 2026-11-13 | Definitions where the brief is silent: credit exposure is outstanding invoiced balance plus confirmed uninvoiced orders; ageing buckets are days past due (Current, 1 to 30, 31 to 60, 61 to 90, over 90); mortality rate is deaths per 1,000 head-days; average daily gain and feed conversion as in FR-LIV-005 and FR-LIV-016; in a tax-inclusive split the leftover pesewa goes to net first and then to levies in calculation order (used by FR-WHL-006, FR-WHL-010, FR-RPT-002, FR-MDM-014) | Accountant | B4 | Open |

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
