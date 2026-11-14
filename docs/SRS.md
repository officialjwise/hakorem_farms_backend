# HaKorem Farms Platform: Software Requirements Specification

Version 1.0, written in session B1 on 2026-11-13. Contract version 1.0.0. This document is the list of what the system must do and how well, in numbered requirements that a test can prove. It does not say how the system is built: that is `docs/ARCHITECTURE.md`, the ADRs and the data model.

A module session reads only its own module's block in section 4, plus the cross-cutting sections it names. It never needs to load the whole file.

## Contents

1. Introduction
2. Actors
3. Key use cases
4. Functional requirements, one block per module (IAM, MDM, LIV, INV, PRC, PUR, POS, WHL, QUO, SHP, ORD, DEL, BIL, PAY, FIN, CAP, CST, RPT, NTF, DOC, AUD, API)
5. Security requirements (`SEC-NNN`)
6. Non-functional requirements (`NFR-NNN`)
7. Traceability matrix and counts

## 1. Introduction

### 1.1 Purpose

This specification defines version 1 of the HaKorem Farms Platform for four readers: the owner, who accepts the system against it; the backend sessions B2 to B13, which build and prove it; the frontend track, which builds screens against the contract that implements it; and an auditor, who reads it to learn what the system promises about stock, money and investor reporting. Every requirement has an identifier, a rule that can be tested and an acceptance criterion with exact values where money, stock or weight is involved. A requirement without a test in section 7 is not finished.

### 1.2 Scope

**In scope for version 1** are the 22 modules of the shared brief: identity and access (IAM), master data (MDM), livestock (LIV), inventory (INV), processing (PRC), procurement (PUR), retail point of sale (POS), wholesale (WHL), quotations (QUO), the online store (SHP), orders (ORD), delivery (DEL), billing (BIL), payments (PAY), the general ledger (FIN), capital and investors (CAP), costing (CST), reporting (RPT), notifications (NTF), documents (DOC), audit and administration (AUD) and integrations (API). The product serves four channels (retail counter, wholesale, online store with delivery, request for quote), three stock archetypes (serialised animal, catch-weight lot, countable unit), one currency (GHS) and one legal entity with one or more branches (A-001, A-032).

**Out of scope** is everything in `docs/BACKLOG.md`. In particular: payroll (BL-030, so the brief's "payroll if present" is read as "not present": wages reach the ledger by manual journal or expense invoice), more than one currency (BL-002), a second payment aggregator (BL-011), direct integration with an electronic invoice certification service (BL-004), fair-value accounting for livestock (BL-006), direct online purchase of individual live animals (BL-015, A-003), loyalty points (BL-032), route optimisation (BL-033), native mobile applications (BL-031), a supplier self-service portal (BL-035) and specific accounting package adapters (BL-039). Building any of these is a change to this specification, not a build decision.

**Not specified here:** screens and their layout (the frontend repository), the mechanism that makes each rule hold (the ADRs), table and column definitions (`docs/DATA_MODEL.md`), and the wire shape of each operation (`contract/openapi.yaml`, conventions in ADR-0029).

### 1.3 Definitions

The terms used in this document, such as stock unit, lot, hold, reservation, tender, blind close, maker and checker, unit-days and exception, have the meanings in `docs/DOMAIN_MODEL.md` section 2 and in `docs/GLOSSARY.md`. Abbreviations used below:

| Term | Meaning |
| --- | --- |
| Pesewas | The integer unit of money. GHS 1.00 is 100 pesewas (ADR-0001). Every amount in this document is stated in pesewas or in GHS with its pesewa equivalent |
| Maker and checker | The user who requests a sensitive action and the different user who approves it (ADR-0017). A second-person action returns 202 with `ApprovalPending` and takes effect only when a different user approves |
| Exception kind | One of the 19 values of `ExceptionKind` on the daily exception report (`GET /exceptions/daily-report`) |
| Seed value | A starting value for a setting, marked as illustrative until the owner confirms it (A-043) |
| Business date | A calendar date in Africa/Accra |
| Correlation id | The id carried by every request, log line, trace and error response |
| Op | An operationId in `contract/openapi.yaml` |

### 1.4 References

| Reference | Use |
| --- | --- |
| `docs/SHARED_BRIEF.md` | The source of every requirement here |
| `docs/BUILD_PROMPT.md`, `docs/adr/0026-session-schedule-amendment.md` | Session schedule used in the traceability matrix |
| `docs/adr/*.md` | Binding decisions. Cited as ADR-nnnn in requirements |
| `docs/DOMAIN_MODEL.md`, `docs/DATA_MODEL.md`, `docs/data-model/*.md` | Aggregates, invariants, tables |
| `docs/MODULE_BOUNDARIES.md` | Which module owns what |
| `docs/security/SECURITY_ARCHITECTURE.md`, `docs/security/THREAT_MODEL.md` | Controls and the 18 abuse cases (section 4 of the threat model) |
| `docs/ASSUMPTIONS.md` | Assumptions A-001 to A-069, cited by id |
| `docs/BACKLOG.md` | What is out of scope |
| `contract/openapi.yaml` (version 1.0.0), `docs/API.md` | The operations each requirement touches |
| `docs/GLOSSARY.md`, `docs/UAT.md`, `docs/TEST_STRATEGY.md`, `docs/OFFLINE_SYNC.md` | Companion documents written in B1 |

### 1.5 How to read a requirement

Functional requirements are named `FR-<CODE>-NNN`. Each has these lines:

- **Actor**: who or what performs or suffers the action.
- **Trigger**: the event that starts it.
- **Rule**: what must be true. Where the shared brief is ambiguous the clarifying assumption is written into the rule.
- **Outcome**: what an observer sees: a response, a record, an event, a document.
- **Acceptance**: a concrete check, with exact values where money, stock or weight is involved. Fixtures named in acceptance (for example "a goat with tag G-0142") are seed fixtures, not production data.
- **Test**: the proving test, named `test/<layer>/<module>/<subject>.<layer>.spec.ts › <behaviour>`. The layer is `unit`, `int`, `contract`, `e2e` or `smoke` (`docs/TEST_STRATEGY.md`).

Wherever a rule says an action is "approved", a different user approves it through the maker-checker mechanism (ADR-0017); the database refuses an approval whose decider equals its requester. Wherever a rule says "audited", the change and its audit event commit in one transaction (ADR-0006). Wherever a rule says "idempotent", a replay with the same `Idempotency-Key` and body returns the first result, and the same key with a different body returns 409 (ADR-0014). These three sentences are not repeated in every block.

### 1.6 Assumed values used in acceptance criteria

Thresholds and limits are settings, not constants (shared brief, hard rule on configuration). The values below are the seed values used by acceptance tests and by the seed script. A-043 records that the owner sets the real values before go-live. The items marked SA are new in this document and are listed in section 7.4 for entry into `docs/ASSUMPTIONS.md`.

| Id | Setting | Seed value |
| --- | --- | --- |
| A-043 | Mortality or cull write-off needing a second approver and a photograph | GHS 500.00 (50,000 pesewas) or more |
| A-043 | Stock adjustment or stock-take variance needing approval | GHS 500.00 (50,000 pesewas) or more |
| A-043 | Refund approved without a second person | Up to GHS 200.00 (20,000 pesewas); above needs approval |
| A-043 | Purchase order needing approval | Above GHS 2,000.00 (200,000 pesewas) |
| A-043 | Price override limit | Cashier: up to 5 percent below list per line and GHS 100.00 (10,000 pesewas) of variance per shift. Sales: 10 percent per line. Manager: 20 percent per line. Beyond the limit, or outside floor and ceiling, needs approval |
| A-044 | Catch-weight tolerance | 10 percent of the estimated weight, per product |
| A-045 | Checkout stock hold | 15 minutes |
| A-046 | Veterinary withdrawal hold | Cannot be released early by anyone |
| A-041 | Offline tenders | Cash only |
| A-009 | Distribution retention | 40 percent, owner-configurable |
| SA-01 | Login lockout | After 5 consecutive failures; lock 1 minute, doubling for each further failure, capped at 60 minutes |
| SA-02 | Bulk export needing step-up | More than 100 rows |
| SA-03 | Webhook timestamp window | 5 minutes either side of server time |
| SA-04 | Signed URL life for private files | 5 minutes |
| SA-05 | Overdue account hold | An invoice more than 30 days past due |
| SA-06 | Quote validity and margin floor | 14 days; margin floor 10 percent over cost |
| SA-07 | Yield variance flag | Actual yield differing from expected by more than 5 percent of the expected yield |
| SA-08 | Three-way match tolerance | Price 1 percent, quantity zero beyond the receipt |
| SA-09 | Quiet hours | 21:00 to 07:00 Africa/Accra |
| SA-10 | Webhook delivery | 8 attempts, exponential backoff from 1 minute with jitter, capped at 6 hours, then dead-lettered |
| SA-11 | Upload caps | Images 5 MB; PDF and spreadsheets 10 MB |
| SA-12 | Default page size | 25, maximum 100 (the contract's `PageLimit`) |

## 2. Actors

The ten seeded roles are in `iam.role` (`OWNER`, `MANAGER`, `ACCOUNTANT`, `STOREKEEPER`, `CASHIER`, `SALES`, `FARM_HAND`, `DRIVER`, `INVESTOR`, `CUSTOMER`). Roles are editable and granted per branch and optionally per location (ADR-0017); what follows is the seeded intent. "Vet or Farm Hand" in the brief is the single seeded role `FARM_HAND`, which includes the veterinary permissions.

| Actor | Realm | MFA | May do (seeded intent) | May not do |
| --- | --- | --- | --- | --- |
| Owner | Staff | TOTP required | Everything, including role and grant changes (with step-up), reopening a locked period with a reason, approving distributions (with step-up), capital withdrawals, tax scheme activation, reading the audit log and the daily exception report | Approve their own requests |
| Manager | Staff | TOTP required | Approve write-offs, voids, price overrides, quotes below floor, refunds, purchase orders, price lists and promotions; manage users, devices and shifts at their branch; unlock accounts; revoke any session | Post to a closed period; approve their own requests; read the audit log |
| Accountant | Staff | TOTP required | Ledger, periods, manual journals (maker), supplier payments (maker), reconciliation, reports, capital transactions, distribution runs (maker), read the audit log | Sell at the counter; approve their own journals or runs |
| Storekeeper | Staff | Optional | Goods receipt, transfers, adjustments (maker), stock takes, reorder rules, temperature readings, picking and packing | Approve write-offs; post to the ledger directly; act at a location outside their grant |
| Cashier | Staff | Optional | Open and close their own shift, complete counter sales, hold and recall, take tenders, request returns and voids (maker), override price within limit | Approve a void; see expected cash before blind close; sell outside their own open shift; see cost |
| Sales | Staff | Optional | Quotes, requests for quote, business accounts, wholesale orders, credit override requests (maker), standing orders | Approve a quote below floor; release an account hold |
| Vet or Farm Hand | Staff | Optional | Animal register, weights, health events, breeding, feed consumption, mortality reports (maker), processing orders | Approve mortality; sell; see prices |
| Driver | Staff | Optional | See and act only on assigned deliveries; record proof, failure and cash collected; see own cash summary; sync a queued day | See other drivers' deliveries; reconcile own cash |
| Investor | Investor | Optional | Read only their own capital, units, distributions, statement and documents under `/investor/` | Any other read; any write |
| Customer | Customer | Phone verification | Browse, cart, check out, see and reorder their own orders, addresses, documents, quotes, store credit and notification preferences; accept or decline a quote by its signed link | Any staff or investor endpoint; any other customer's record |
| Payment provider | System | Signed webhook | Posts payment and refund events to `POST /webhooks/payments/{provider}` | Anything but webhooks; a bare webhook never marks a payment cleared (FR-PAY-005) |
| Messaging provider | System | Signed webhook | Posts delivery receipts to `POST /webhooks/messaging/{provider}` | Anything but webhooks |
| Integration | API key principal | Key | The scopes granted to its key, rate limited per key | Any scope not granted |
| POS device | Device credential | Device credential | Syncs queued sales for the enrolled register (`POST /pos/sync`), fetches the offline pack | Sync for a different register; act without an open shift on file |
| Scheduler | System | Internal | Expires reservations and checkouts; places overdue holds; generates standing orders and delivery slots; runs reconciliation jobs, depreciation reminders, report schedules, retention and abandoned-cart sweeps | Correct any record: reconciliation raises findings, never fixes them |
| Worker | System | Internal | Dispatches the outbox: notifications, webhooks, document rendering, payment status lookups and refunds, antivirus scans, the audit sealer and anchor | Run an external call inside a business transaction |

## 3. Key use cases

The first seven are the system acceptance scenarios of the shared brief. They become the scripted runs in `docs/UAT.md` and are executed in B13 on staging, driven by a non-developer wherever possible. Each lists the requirements it exercises; the end-to-end test that runs it is named in section 7.

**UC-01 A full trading day.** Actor: farm manager, with cashier, storekeeper and driver. Flow: open a shift with a float of GHS 500.00; receive twenty broilers from a supplier against a purchase order; sell three goats at the counter by weight with a split cash and mobile money tender; process one goat into meat lots; fulfil an online order; deliver it against cash on delivery; close the shift blind. Result: physical stock matches the system, the trial balance sums to zero, declared cash matches the ledger, every document is archived and reprintable. Exercises FR-POS-001 to FR-POS-006, FR-POS-015, FR-POS-018, FR-POS-019, FR-PUR-005, FR-PUR-007, FR-INV-009, FR-PRC-001 to FR-PRC-003, FR-PRC-007, FR-SHP-005, FR-SHP-011, FR-ORD-008 to FR-ORD-011, FR-DEL-008 to FR-DEL-010, FR-FIN-006, FR-FIN-011, FR-BIL-008, FR-BIL-009 and FR-DOC-001.

**UC-02 Quote to cash.** Actor: sales officer, buyer, manager. Flow: a buyer requests twenty goats for a funeral; a quote is issued; the buyer negotiates and receives a revision; accepts by signed link; takes a partial delivery; is invoiced; pays part; appears in the 30-day band of the ageing report. Exercises FR-QUO-001 to FR-QUO-011, FR-ORD-012, FR-DEL-008, FR-BIL-006, FR-PAY-009 and FR-WHL-010.

**UC-03 Traceability.** Actor: manager or accountant. Flow: pick any sold meat lot and trace it back to the individual animal, its supplier, its feed and veterinary costs in three clicks or fewer. Exercises FR-INV-006, FR-PRC-003, FR-LIV-001 and FR-CST-001.

**UC-04 Investor distribution.** Actor: accountant (maker), owner (checker), investors. Flow: two investors who contributed on different dates receive a quarterly distribution. Result: the allocation equals the hand calculation on unit-days with largest-remainder rounding (ADR-0028) and the posting ties exactly to the ledger. Exercises FR-CAP-003 to FR-CAP-013 and FR-FIN-011.

**UC-05 Fraud attempts.** Actor: a tester playing a dishonest insider, customer and outsider. Flow: attempt every one of the 18 abuse cases. Result: each is blocked outright or lands on the daily exception report with the actor, amount and subject document. Exercises SEC-001 to SEC-018 and FR-RPT-007.

**UC-06 Offline counter.** Actor: cashier. Flow: disconnect the POS for an hour, run fifty transactions, reconnect. Result: every sale syncs exactly once, no duplicate appears, any stock conflict is flagged rather than silently resolved. Exercises FR-POS-010 to FR-POS-014, SEC-010 and SEC-011.

**UC-07 Disaster recovery.** Actor: administrator. Flow: restore last night's backup into a clean environment, verify the trial balance matches, record the elapsed time. Exercises NFR-007 to NFR-009 and FR-AUD-012.

**UC-08 Online order with catch weight.** Actor: customer, picker, driver. A customer orders 2 packs of beef online, sees the estimate and the highest possible total, pays the estimate; the picker weighs; the invoice is raised on the weighed quantity; the difference is settled and the customer notified. Exercises FR-SHP-007, FR-ORD-009 to FR-ORD-011 and FR-BIL-005.

**UC-09 Credit sale and account hold.** Actor: sales officer, wholesale customer. A business account near its limit places an order; the order waits for an audited override; the account later goes on automatic hold when an invoice is 31 days past due. Exercises FR-WHL-006 to FR-WHL-008 and SEC-014.

**UC-10 Investor looks at their position.** Actor: investor. Logs in to the investor realm, sees only their own units, contributions, allocations and statement, and is refused anything else. Exercises FR-IAM-013, FR-CAP-013 and SEC-008.

## 4. Functional requirements

Sessions that build and prove each module are given in section 7; the first line of each module block states the module's default session. A requirement that is proven in a later session than its module's default says so in section 7.

### 4.1 IAM: Identity, access and roles

Default session: B3. Brief bullets: staff accounts, login and TOTP (001 to 007, 020); roles and permissions (008 to 012, 021, 022); branch and location scoping (011); sessions, lockout and authentication audit (014 to 018); investor portal access (013); customer realm (019).

**FR-IAM-001** Create a staff account
- Actor: Manager or Owner
- Trigger: `createUser` for a staff member
- Rule: A staff account has an email or a Ghana phone number (E.164, +233) or both, a full name, and a role grant at a branch. Email and phone are each unique among live accounts of the realm. The system generates a temporary password, shows it once, and sets `must_change_password`.
- Outcome: 201 with the user; the temporary password is in no later response, log or audit payload.
- Acceptance: Creating a user with phone +233244123456 twice gives 422 on the second; an archived account's phone can be reused; the audit event for the creation contains no password.
- Test: `test/int/iam/staff-accounts.int.spec.ts › refuses a duplicate live phone or email in the same realm`

**FR-IAM-002** Staff login by email or phone
- Actor: Staff member
- Trigger: `loginStaff` with identifier and password
- Rule: The identifier is an email or a phone number; the password is verified against an Argon2id hash. A wrong password, an unknown identifier and a disabled account return the same 401 body and message. An unknown identifier still verifies a dummy hash so the work done is the same.
- Outcome: Success sets the staff session cookies (`__Host-hk_s_at`, `__Host-hk_s_rt`) and returns the session; failure returns one generic message with a correlation id.
- Acceptance: The response bodies for unknown identifier, wrong password and disabled account are byte-identical apart from the correlation id; a unit test asserts the hash function runs exactly once for an unknown identifier.
- Test: `test/int/iam/staff-login.int.spec.ts › returns an identical failure for unknown, wrong and disabled accounts`

**FR-IAM-003** Argon2id password hashing
- Actor: System
- Trigger: Any password set
- Rule: Passwords are stored only as Argon2id hashes with a per-password salt. Parameters are configuration, starting at 64 MiB memory, 3 iterations, parallelism 1 and tuned to about 250 ms on the production server (A-066). A login with an older parameter set rehashes the password.
- Outcome: No plaintext, reversible or unsalted hash exists in any table, log or backup.
- Acceptance: The stored value starts with `$argon2id$`; two accounts with the same password have different hashes; raising the memory parameter causes a rehash on the next successful login.
- Test: `test/unit/iam/password-hashing.unit.spec.ts › stores argon2id with a unique salt and rehashes on parameter change`

**FR-IAM-004** Forced password change on first login
- Actor: Newly created staff member
- Trigger: First successful `loginStaff`
- Rule: While `must_change_password` is set, the only operations the session may call are `changePassword`, `logout` and `getCurrentSession`. The new password must differ from the temporary one.
- Outcome: Every other operation returns 403 until the password is changed; on change the flag clears and every other session of the user is revoked.
- Acceptance: A new user logging in with the temporary password gets 403 on `GET /products` and 200 on `POST /auth/password/change`; the next `GET /products` is 200.
- Test: `test/int/iam/forced-password-change.int.spec.ts › blocks every operation except password change until changed`

**FR-IAM-005** Password policy and breached-password check
- Actor: Any user setting a password
- Trigger: `changePassword`, `resetPassword`, `createUser`
- Rule: A password is at least 12 characters and is checked at set time against a breached-password list by k-anonymity range query, with a bundled list of common passwords as the fallback when the service is unreachable. A password containing the account's email local part is refused.
- Outcome: A refused password gives 422 with the reason category, never the matched hash.
- Acceptance: `Password1234!` is refused as common; a 16-character random string is accepted; with the range service unreachable, the bundled list still refuses `Password1234!` and the request does not fail with 500.
- Test: `test/int/iam/password-policy.int.spec.ts › refuses breached passwords and falls back to the bundled list`

**FR-IAM-006** TOTP mandatory for Owner, Accountant and Manager
- Actor: Owner, Accountant, Manager
- Trigger: Login
- Rule: Login for these roles is not complete until a TOTP (RFC 6238, 30-second step, one step of drift allowed) is verified. A user with no enrolled secret can only enrol. The secret is column-encrypted (ADR-0022); ten recovery codes are shown once and stored hashed. A code is accepted once per time step. Other roles may enrol voluntarily.
- Outcome: A session for these roles has a verified-second-factor flag; operations other than enrolment, verification and logout refuse a session without it.
- Acceptance: A Manager login without TOTP cannot call `GET /iam/users` (403); after `confirmTotpEnrolment` it can; replaying the same 6-digit code within its step is refused; a recovery code works once.
- Test: `test/int/iam/totp.int.spec.ts › requires a verified second factor for owner, accountant and manager`

**FR-IAM-007** Step-up authentication
- Actor: Owner, Accountant, Manager
- Trigger: `stepUp` before a sensitive action
- Rule: Posting a distribution run, a bulk export, a role or grant change and a posting rule change each require a TOTP verified on that session within the last 5 minutes.
- Outcome: Without fresh step-up the action returns 403 with the step-up-required code and nothing changes.
- Acceptance: `postDistributionRun` with a step-up 6 minutes old returns 403; after `stepUp` it succeeds; the step-up time is carried in the session, not in the request.
- Test: `test/int/iam/step-up.int.spec.ts › refuses sensitive actions without a step-up in the last five minutes`

**FR-IAM-008** Seeded roles and granular permissions
- Actor: Owner
- Trigger: Deployment; `createRole`, `updateRole`
- Rule: A permission is a code `<module>.<resource>.<action>` seeded by migration. The ten roles Owner, Manager, Accountant, Storekeeper, Cashier, Sales, Farm Hand (Vet or Farm Hand), Driver, Investor and Customer are seeded as system roles that cannot be deleted. Role edits are audited and need step-up.
- Outcome: `listRoles` returns the ten roles with their permission sets; `listPermissions` returns every code the contract names in `x-permission`.
- Acceptance: A fresh database lists exactly 10 system roles; deleting or archiving one returns 422; every `x-permission` value in the contract exists in `iam.permission`.
- Test: `test/int/iam/roles-seed.int.spec.ts › seeds ten system roles and every contract permission`

**FR-IAM-009** Deny by default, checked in the domain layer
- Actor: Any principal
- Trigger: Any command or query
- Rule: Every handler calls the policy engine `authorise(actor, permission, scope)` before doing work. A handler or route with no declared permission fails the build. No path grants access by absence of a rule.
- Outcome: A principal without a current grant containing the permission gets 403 with the standard envelope.
- Acceptance: A test walks every registered handler and route and fails if any lacks a declared permission; a Cashier calling `createManualJournal` gets 403; calling the domain service directly (no HTTP) with the same actor is also refused.
- Test: `test/unit/iam/policy-engine.unit.spec.ts › refuses every handler that does not declare a permission`

**FR-IAM-010** Object-level ownership
- Actor: Customer, Investor, Driver, Cashier
- Trigger: A read or write of a record they can reach
- Rule: Each resource declares an ownership rule checked on every read and write: a customer sees only their own orders, addresses, documents and quotes; an investor only their own capital, units, distributions and documents; a driver only deliveries assigned to them; a cashier only their own open shift.
- Outcome: A record owned by someone else is refused and an authorisation-failure event is recorded for the daily exception report.
- Acceptance: Customer A requesting customer B's order by id gets 403 and one `AUTHORISATION_FAILURE` exception; driver D1 reading D2's delivery gets 403; the order list for customer A never includes B's rows.
- Test: `test/int/iam/ownership.int.spec.ts › refuses a record owned by another principal`

**FR-IAM-011** Branch and location scoping
- Actor: Cashier, Storekeeper, Farm Hand
- Trigger: Any state-changing operation naming a branch or location
- Rule: A role grant names a branch, optionally one location, and a validity range. The handler checks that the operation's branch, and location where one is named, lie inside a current grant that holds the permission. A cashier at the shop cannot post a movement at the farm.
- Outcome: Out-of-scope operations are refused with 403; a permission change takes effect on the next request because the grant cache is invalidated by any grant change.
- Acceptance: A cashier granted `inv.movement.create` at the shop location only gets 403 posting a goods receipt at the farm location; after `revokeGrant` the cashier's next request is refused without waiting for cache expiry.
- Test: `test/int/iam/grant-scope.int.spec.ts › refuses an action outside the grant's branch or location`

**FR-IAM-012** Maker-checker approvals
- Actor: Maker and checker (staff)
- Trigger: An action that needs a second person
- Rule: An action of kind `STOCK_WRITE_OFF`, `STOCK_REVERSAL`, `SALE_VOID`, `PRICE_OVERRIDE`, `QUOTE_BELOW_MARGIN`, `CREDIT_OVERRIDE`, `REFUND`, `RETURN`, `PRICE_LIST_ACTIVATION`, `PROMOTION_ACTIVATION`, `TAX_SCHEME_ACTIVATION`, `PURCHASE_ORDER`, `SUPPLIER_PAYMENT`, `SUPPLIER_PAYOUT_CHANGE`, `MANUAL_JOURNAL`, `POSTING_RULE_CHANGE`, `CAPITAL_WITHDRAWAL`, `INVESTOR_DISTRIBUTION`, `DATA_DELETION`, `BAD_DEBT_WRITE_OFF`, `CREDIT_NOTE`, `PAYMENT_REVERSAL` or `PERIOD_REOPEN` returns 202 with `ApprovalPending`. A checker with the approver permission approves or rejects; the approval binds to the payload hash, so a changed subject voids it. The decider must differ from the requester by a database check. The owning module's handler runs in the same transaction as the approval.
- Outcome: The subject takes effect only on approval; a rejection leaves it unchanged with a reason.
- Acceptance: A manager approving their own write-off gets 422 `MAKER_CANNOT_CHECK` and a direct SQL update setting `decided_by = requested_by` violates the check constraint; editing the write-off after the request makes the approval void.
- Test: `test/int/iam/approvals.int.spec.ts › refuses a self-approval and voids an approval whose payload changed`

**FR-IAM-013** Investor portal isolation
- Actor: Investor
- Trigger: Any request under `/investor/` or with an investor session
- Rule: Investors authenticate on their own realm endpoint and cookie. The investor identity comes from the session, never from a path or query parameter. Investor endpoints return only that investor's capital transactions, units, distributions, statement and documents. An investor session is refused on every staff and customer operation, and a staff or customer session on every investor operation.
- Outcome: An investor sees no ledger, price, cost, customer, stock or other investor's data.
- Acceptance: Investor 001 calling `GET /investors/{id}` or `GET /finance/trial-balance` gets 403; `GET /investor/statement` returns only investor 001's lines; presenting a staff cookie to `/investor/me` is refused.
- Test: `test/int/iam/investor-isolation.int.spec.ts › returns only the caller's own data and refuses all other operations`

**FR-IAM-014** Session list and own session revocation
- Actor: Any authenticated user
- Trigger: `listSessions`, `revokeSession`
- Rule: Each login creates a session with device label, IP address and last-seen time. A user lists their own sessions and revokes any of them. Revocation sets `revoked_at`; nothing is deleted.
- Outcome: A revoked session's tokens are refused on the next request.
- Acceptance: After revoking session S2 from session S1, a request using S2 returns 401 and S1 still works; the row for S2 remains with `revoked_at` set.
- Test: `test/int/iam/sessions.int.spec.ts › lists devices and revokes a session without deleting it`

**FR-IAM-015** Forced logout and account disable
- Actor: Manager
- Trigger: `revokeSession` on another user's session; `disableUser`
- Rule: A manager can revoke any session at their branch and disable an account, which revokes all its sessions and refresh tokens at once. Disabling is reversible by `enableUser`.
- Outcome: The user is logged out of every device on their next request.
- Acceptance: After `disableUser`, all 3 live sessions of the user return 401 and login returns the generic failure; `enableUser` restores login.
- Test: `test/int/iam/forced-logout.int.spec.ts › disabling a user revokes all of their sessions`

**FR-IAM-016** Token lifetimes and refresh rotation
- Actor: Any session
- Trigger: Request with an expired access token; `refreshSession`
- Rule: The access token lasts 10 minutes. The staff refresh token is valid 12 hours idle and 7 days absolute, which covers an 8-hour offline shift (A-065); customer 30 days idle and 90 absolute. Each refresh rotates the token. A rotated token presented again revokes the whole session and raises `iam.RefreshTokenReuseDetected`.
- Outcome: The client holds a continuously valid session until the absolute limit; a copied token is detected.
- Acceptance: Refreshing twice with the first token revokes the session and the second request returns 401; a staff refresh after 12 hours idle returns 401; an access token is unusable at 10 minutes 1 second.
- Test: `test/int/iam/token-rotation.int.spec.ts › revokes the session when a rotated refresh token is reused`

**FR-IAM-017** Lockout with exponential backoff
- Actor: System
- Trigger: Consecutive failed logins on one account
- Rule: After 5 consecutive failures the account is locked for 1 minute, doubling with each further failure up to 60 minutes (SA-01). A correct password while locked still returns the generic failure. A manager can unlock. Failures are also rate limited per IP address.
- Outcome: Lockout does not reveal whether the account exists: an unknown identifier behaves identically.
- Acceptance: Failures 1 to 4 return the generic 401; after the 5th a correct password still fails for 60 seconds; the 6th failure locks for 2 minutes; `unlockUser` restores login at once.
- Test: `test/unit/iam/lockout.unit.spec.ts › doubles the lock period per failure and caps it at sixty minutes`

**FR-IAM-018** Authentication audit
- Actor: System
- Trigger: Every authentication event
- Rule: Login success and failure, logout, lockout, unlock, password change and reset, TOTP enrolment and verification, step-up, session revocation and refresh-token reuse are audited with actor (or attempted identifier, masked), IP, user agent, realm and correlation id.
- Outcome: Owner and Accountant can search these events; no event contains a password, token or TOTP code.
- Acceptance: One failed and one successful login produce two audit events with distinct outcomes; a search for the masked identifier `+23324*****56` returns both; no payload contains the submitted password.
- Test: `test/int/iam/auth-audit.int.spec.ts › records every authentication event without secrets`

**FR-IAM-019** Customer registration and login
- Actor: Customer
- Trigger: `registerCustomer`, `verifyCustomerPhone`, `loginCustomer`
- Rule: A customer registers with a Ghana phone number and a password and verifies the phone with a 6-digit code valid 10 minutes with at most 5 attempts. The customer realm has its own endpoints and cookies and cannot reach staff operations. Registration answers identically whether or not the phone is known.
- Outcome: A verified customer can place orders under their own record.
- Acceptance: Registering an existing phone returns the same response as a new one and sends no second account; a 6th wrong code is refused even if correct; a customer cookie on `GET /iam/users` is refused.
- Test: `test/int/iam/customer-realm.int.spec.ts › registers, verifies and isolates the customer realm`

**FR-IAM-020** Password reset
- Actor: Any user
- Trigger: `requestPasswordReset`, `resetPassword`
- Rule: A reset request always answers that a message is sent if the account exists. The single-use token expires in 30 minutes, is stored hashed, and revokes all sessions of the account when used. Reset is rate limited per address and account (fail closed).
- Outcome: No response or timing reveals whether the account exists.
- Acceptance: Requests for a known and an unknown address return identical bodies; using a token twice fails; after reset the previous sessions return 401.
- Test: `test/int/iam/password-reset.int.spec.ts › answers identically and revokes sessions on use`

**FR-IAM-021** Approval policies
- Actor: Owner
- Trigger: `listApprovalPolicies`, `updateApprovalPolicy`
- Rule: Per approval kind and branch, a policy sets the threshold at or above which approval is needed and the permission the approver must hold. Thresholds are audited settings. A kind with no threshold always needs approval.
- Outcome: Changing a threshold takes effect on the next request and is audited with before and after values.
- Acceptance: With the write-off threshold at 50,000 pesewas, a 49,999 write-off posts directly and a 50,000 one returns 202; after raising it to 100,000 a 50,000 one posts directly and the audit event shows 50,000 to 100,000.
- Test: `test/int/iam/approval-policy.int.spec.ts › applies the threshold at or above the policy value`

**FR-IAM-022** Role and grant change controls
- Actor: Owner
- Trigger: `createGrant`, `revokeGrant`, `updateRole`
- Rule: Role and grant changes need step-up. A principal cannot grant themselves a role or permission they do not hold, and cannot change their own grants. Every change is audited and appears on the permission-change report to the owner.
- Outcome: A self-grant is refused; every accepted change lands on the daily exception report as `PERMISSION_CHANGE`.
- Acceptance: A manager granting themselves OWNER gets 403; a grant by the owner for a manager creates a `PERMISSION_CHANGE` item naming granter, grantee and role.
- Test: `test/int/iam/grant-controls.int.spec.ts › refuses self-grants and reports every grant change`

### 4.2 MDM: Master data, pricing and tax

Default session: B4. Includes the pricing engine, promotions and the tax calculator, which MODULE_BOUNDARIES assigns to MDM. Brief bullets: catalogue (001 to 004); grades and weight bands (005); locations, suppliers, customers, tax, payment methods, zones (006 to 014, 022); price lists with approval (015, 016, 021); import and export (019, 020). The pricing engine (016, 017) and promotions (018) serve the brief's third domain point.

**FR-MDM-001** Product with a stock-keeping policy
- Actor: Manager
- Trigger: `createProduct`
- Rule: A product has a category, a name, a stock-keeping policy of `SERIALISED`, `CATCH_WEIGHT` or `COUNTABLE`, a base unit, a tax category and a GL group. The policy cannot change once the product has any stock movement; the check goes through a usage port that inventory implements.
- Outcome: 201 with the product in `DRAFT`; a policy change on a product with movements returns 422.
- Acceptance: Goat (`SERIALISED`) is created; after one receipt movement, `updateProduct` setting `CATCH_WEIGHT` returns 422 and the policy is unchanged.
- Test: `test/int/mdm/product-policy.int.spec.ts › refuses a policy change once movements exist`

**FR-MDM-002** Category tree
- Actor: Manager
- Trigger: `createCategory`, `archiveCategory`
- Rule: Categories form a tree. A category with live products or live children cannot be archived. Names are unique among siblings.
- Outcome: The tree is returned with counts; archiving a used category returns 422.
- Acceptance: Archiving "Meat" while "Beef" has 3 live products returns 422; archiving the emptied "Beef" succeeds and its history stays readable.
- Test: `test/int/mdm/categories.int.spec.ts › refuses to archive a category that is still in use`

**FR-MDM-003** Units of measure and exact conversions
- Actor: Manager
- Trigger: `createProduct` with units
- Rule: Each product has a base unit and optional alternative units with an exact decimal factor (head, kg, 15 kg pack, crate of 30 eggs, bunch, tuber). Conversions are exact decimals to three places; a conversion that cannot be represented exactly is refused. Weight is kilograms to 3 places.
- Outcome: Quantities in an alternative unit convert to base without rounding error.
- Acceptance: A 15 kg pack at factor 15.000 converts 2 packs to 30.000 kg; a crate of 30 converts 3 crates to 90.000 eggs; a factor of 0.3333333 is refused.
- Test: `test/unit/mdm/unit-conversion.unit.spec.ts › converts packs and crates exactly and refuses inexact factors`

**FR-MDM-004** Product descriptions, images and online visibility
- Actor: Manager
- Trigger: `addProductImage`, `updateProduct`
- Rule: A product has a description, SEO title and description, a slug unique among live products, and up to 8 images (JPEG, PNG or WebP, content-sniffed, 5 MB cap). Online mode is `HIDDEN`, `LISTED` or `REQUEST_TO_BUY`; serialised live animals are seeded `REQUEST_TO_BUY` (A-003).
- Outcome: The public catalogue shows only `LISTED` and `REQUEST_TO_BUY` active products with their image variants.
- Acceptance: A product set to `HIDDEN` is absent from `GET /shop/catalogue`; a PNG renamed `.jpg` that is really a ZIP is refused; a 9th image is refused.
- Test: `test/int/mdm/product-media.int.spec.ts › lists only visible products and refuses non-image uploads`

**FR-MDM-005** Species, grades and weight bands
- Actor: Manager
- Trigger: `createSpecies`, `createGrade`, `createWeightBand`
- Rule: Each species has grades and non-overlapping weight bands in kilograms, expressed as half-open ranges so that 20.000 kg falls in exactly one band. Bands are used identically by pricing and quoting. The overlap rule is a database exclusion constraint.
- Outcome: Overlapping bands are refused; a weight maps to one band or none.
- Acceptance: Bands 10.000 to 20.000 and 20.000 to 30.000 are accepted; adding 19.500 to 25.000 is refused by the database; a 20.000 kg goat maps to the second band; 35.000 kg maps to none.
- Test: `test/int/mdm/weight-bands.int.spec.ts › rejects overlapping bands and maps a weight to one band`

**FR-MDM-006** Branches and locations
- Actor: Owner, Manager
- Trigger: `createBranch`, `createLocation`
- Rule: Multi-location is built from day one with a single location running (A-001). A location belongs to exactly one branch and its parent is in the same branch. Location kinds include pen, cold room, shop floor, vehicle, returns hold and in transit; cold rooms carry a temperature range. Virtual locations (supplier, customer, loss, production, processing, consumption) are seeded and cannot be edited.
- Outcome: Locations nest within a branch; a location with stock cannot be archived.
- Acceptance: Creating a pen whose parent is in another branch returns 422 and the database also refuses it; archiving a cold room holding 1 lot returns 422.
- Test: `test/int/mdm/locations.int.spec.ts › keeps parent and child in one branch`

**FR-MDM-007** Supplier identity
- Actor: Manager, Storekeeper
- Trigger: `createSupplier`
- Rule: Supplier identity (name, phone in E.164, address, categories supplied) is shared reference data. Commercial terms and payout details belong to procurement (FR-PUR-001). A supplier with documents or open orders is archived, never deleted.
- Outcome: A supplier can be created, found by name or phone, and archived.
- Acceptance: Two live suppliers with the same phone return 422; archiving a supplier with an open purchase order returns 422.
- Test: `test/int/mdm/supplier-identity.int.spec.ts › refuses duplicate live suppliers`

**FR-MDM-008** Customers, tiers and addresses
- Actor: Sales, Manager
- Trigger: `createCustomer`, `createCustomerTier`, `createCustomerAddress`
- Rule: A customer has a kind (individual or business), a phone in E.164, optional email, a tier and any number of addresses in Ghana format (digital address code, area, landmark, region). Phone is unique among live customers. Customer data is personal data under FR-AUD-011.
- Outcome: Customers are searchable by phone and name; an archived customer keeps their documents.
- Acceptance: `+233` numbers entered as `0244123456` are stored as `+233244123456`; a duplicate is refused; an address needs a region and a landmark or digital address.
- Test: `test/int/mdm/customers.int.spec.ts › normalises Ghana phone numbers and refuses duplicates`

**FR-MDM-009** Payment methods
- Actor: Owner, Manager
- Trigger: `updatePaymentMethod`
- Rule: Methods are `CASH`, `MOBILE_MONEY`, `CARD`, `BANK_TRANSFER`, `CHEQUE` and `STORE_CREDIT`, each with its clearing behaviour, whether it needs provider verification, whether it is allowed offline (cash only by default, A-041) and the ledger account it settles to.
- Outcome: Disabling a method hides it from tender screens; verification flags cannot be switched off for mobile money and card.
- Acceptance: Setting `requires_verification = false` on `MOBILE_MONEY` returns 422; disabling `CHEQUE` removes it from `GET /payment-methods` for new sales.
- Test: `test/int/mdm/payment-methods.int.spec.ts › keeps verification mandatory for mobile money and card`

**FR-MDM-010** Delivery zones and fees
- Actor: Manager
- Trigger: `createDeliveryZone`
- Rule: A zone has a name, a fee in pesewas, a minimum order value, a cut-off time and the days served. Fees are integers. A zone fee can be zero.
- Outcome: `POST /shop/delivery/quote` returns the fee of the zone for an address.
- Acceptance: Zone "Dodowa" with fee 1,500 pesewas returns exactly 1,500 for an address in it; an address in no zone returns "delivery unavailable", not zero.
- Test: `test/int/mdm/delivery-zones.int.spec.ts › returns the zone fee or unavailable`

**FR-MDM-011** Fixed reason codes
- Actor: System
- Trigger: Migration
- Rule: Reason codes used by adjustments, mortality, cull, wastage, price override, void, refund, return, cancellation, delivery failure, cash movement and hold release are a fixed list changed only by migration, never through the API. Some require a free-text note and carry the ledger loss group.
- Outcome: The API lists reason codes and offers no write operation.
- Acceptance: The contract has no create or update operation for reason codes; posting an adjustment with a code outside the list returns 422.
- Test: `test/int/mdm/reason-codes.int.spec.ts › accepts only codes from the fixed list`

**FR-MDM-012** Tax configuration as effective-dated versions
- Actor: Accountant (maker), Owner (checker)
- Trigger: `createTaxSchemeVersion`, `replaceTaxSchemeCells`, `submitTaxSchemeVersion`
- Rule: The tax matrix holds a row for every category and levy (VAT, NHIL, GETFund) with treatment, rate, base kind, reclaimable flag and calculation order. A version activates only when every row exists; it is then immutable and versions cannot overlap in time. Seed: live animals, raw produce, eggs and farm inputs zero-rated; processed meat, other goods and delivery 15, 2.5 and 2.5 percent on one base, no compounding (ADR-0020, A-021). The setting `tax.registered` switches charging and recovery off.
- Outcome: An incomplete version is refused; an active version cannot be edited.
- Acceptance: Submitting a version missing the EGGS/NHIL row returns 422 `TAX_MATRIX_INCOMPLETE`; the author approving their own version returns 422 `MAKER_CANNOT_CHECK`; updating an active cell is refused by the database.
- Test: `test/int/mdm/tax-scheme.int.spec.ts › refuses an incomplete matrix and freezes an active version`

**FR-MDM-013** Exact tax-exclusive calculation
- Actor: Quote, cart, order, billing and purchasing
- Trigger: `calculateTax`
- Rule: For a tax-exclusive line the anchor is the rounded line net; each levy is `half_up(base x rate)` on an integer base; gross is net plus levies; a row is produced for every levy including zero ones.
- Outcome: Totals are the sum of line integers; no total is recomputed from another total.
- Acceptance: A processed-meat line with net 10,000 pesewas (GHS 100.00) gives VAT 1,500, NHIL 250, GETFund 250 and gross 12,000; a zero-rated goat line shows three rows at 0 and states `ZERO_RATED`; with `tax.registered = false` all levies are 0.
- Test: `test/unit/mdm/tax-calculator.unit.spec.ts › computes levies on a tax-exclusive line with no compounding`

**FR-MDM-014** Exact tax-inclusive calculation
- Actor: Quote, cart, order, billing
- Trigger: `calculateTax` on an inclusive price
- Rule: For a tax-inclusive price the anchor is the gross. Net and each levy come from `allocate` with weights 1 : e1 : e2 : e3 (effective rates), so the parts sum to the gross exactly; ties on the leftover pesewa go to net first, then levies in calculation order.
- Outcome: The parts always sum to the gross.
- Acceptance: Gross 10,000 pesewas gives net 8,334, VAT 1,250, NHIL 208, GETFund 208 (sum 10,000); gross 12,000 gives net 10,000, VAT 1,500, NHIL 250, GETFund 250; independent half-up rounding of the parts (8,333 + 1,250 + 208 + 208 = 9,999) is shown not to be used.
- Test: `test/unit/mdm/tax-calculator.unit.spec.ts › splits an inclusive gross into parts that sum exactly`

**FR-MDM-015** Price lists, versions and approval
- Actor: Manager (maker), Manager or Owner (checker)
- Trigger: `createPriceList`, `createPriceListVersion`, `replacePriceListEntries`, `submitPriceListVersion`
- Rule: Price lists are of kind `CUSTOMER`, `TIER`, `CHANNEL` or `BASE`, with a tax-inclusive flag (A-023). A version has a validity range, is drafted, approved by a different user, then active. An active version is immutable; two active versions of one list cannot overlap in time (database exclusion). Within a version, product with grade and band is unique, and floor <= list <= ceiling.
- Outcome: The new version goes live at its start time only after approval; an earlier sale's price reference still reproduces its price.
- Acceptance: An author approving their own version is refused; overlapping a second active version for 1-30 Nov and 15 Nov-15 Dec is refused; an entry with floor 90,000, list 80,000 is refused; editing an active entry is refused.
- Test: `test/int/mdm/price-list-versions.int.spec.ts › needs a second approver and refuses overlap`

**FR-MDM-016** Price resolution order
- Actor: Pricing engine
- Trigger: `resolvePrices`
- Rule: Given product, optional grade, optional weight, channel, optional customer, quantity, branch and time, the engine takes, in order: an accepted quote line's price; then the customer's price list; then the list for the customer's tier and channel; then the channel list; then the base list. Within a list the most specific entry wins (product+grade+band, then +band, then +grade, then product). A `quote_only` entry stops the walk.
- Outcome: The result is `Resolved` with list, floor, ceiling, basis and the entry id, or `QuoteRequired` with reason `NO_RULE`, `QUOTE_ONLY` or `MISSING_GRADE_OR_WEIGHT`; it never returns zero and never throws for a business outcome.
- Acceptance: A wholesale customer with a customer list entry of 85,000 for goat grade A band 20-25 kg gets 85,000, not the channel list's 90,000; a goat with no weight gets `MISSING_GRADE_OR_WEIGHT`; a `quote_only` entry returns `QUOTE_ONLY` even though the base list has a price.
- Test: `test/unit/mdm/pricing-engine.unit.spec.ts › resolves by precedence, specificity and quote-only`

**FR-MDM-017** Price bands, variance and quote-required behaviour
- Actor: Pricing engine, Cashier, Sales
- Trigger: `resolvePrices` then a sale line
- Rule: A resolved price is a band (floor, list, ceiling). The agreed price may differ; the line stores resolved list, floor, ceiling, rule reference, agreed price, variance amount and direction, reason code and any approval. An unresolved price is "quote required", not an error: the storefront shows "Request a quote", the counter cannot add the line, wholesale saves the line as needing a quote.
- Outcome: Anything the engine cannot resolve becomes a quote.
- Acceptance: Goat grade A, band 20-25 kg, retail list 90,000, floor 80,000, ceiling 100,000: agreed 85,000 records a variance of 5,000 below list with a reason; agreed 75,000 is outside the floor and is refused without approval; an unresolved line yields `QUOTE_REQUIRED` at the counter.
- Test: `test/unit/mdm/pricing-engine.unit.spec.ts › records variance and returns quote-required instead of an error`

**FR-MDM-018** Promotions, coupons and bundles in the engine
- Actor: Manager (maker), Manager or Owner (checker)
- Trigger: `createPromotion`, `submitPromotion`, `createCoupon`, `validateCoupon`
- Rule: A promotion has targets (products, categories, channels, tiers), a discount (percent or fixed pesewas, or a bundle price), validity, a stack group and an exclusive flag. Promotions apply after the base price and only to prices from the tier, channel or base lists, never to a contract price. At most one promotion per stack group; an exclusive promotion excludes all others. A coupon cannot be redeemed beyond its total or per-customer limit, checked under a row lock. Every discount posts to account 4220.
- Outcome: Discounts are separate recorded adjustments on the line.
- Acceptance: Two promotions in one stack group: only the larger applies; an exclusive 10 percent promotion with a second 5 percent in another group applies only the exclusive one; a coupon limited to 100 redemptions refuses the 101st under 20 concurrent redemptions without exceeding 100.
- Test: `test/int/mdm/promotions.int.spec.ts › enforces stacking rules and coupon limits under concurrency`

**FR-MDM-019** Spreadsheet import with dry run
- Actor: Manager
- Trigger: `createImportJob`, `applyImportJob`
- Rule: Products, categories, customers, suppliers, locations, grades, bands, price list entries and opening stock templates may be imported from a spreadsheet. A job first runs as a dry run that validates every row and reports row errors without writing anything. Apply is allowed only on a job whose dry run has zero errors, and runs in one transaction.
- Outcome: The dry-run preview lists counts of rows to create and update and each row error with its row number and column.
- Acceptance: A file with 200 rows and 3 bad rows produces 3 errors and zero database writes; applying it is refused; the corrected file applies all 200 rows or none; the job and its error rows stay readable.
- Test: `test/int/mdm/import-jobs.int.spec.ts › writes nothing in a dry run and applies all or none`

**FR-MDM-020** Spreadsheet export
- Actor: Manager, Accountant
- Trigger: `createExportJob`
- Rule: Master data exports need the export permission, are audited with the user, parameters and row count, and above 100 rows need step-up (SA-02).
- Outcome: The file is delivered by a signed, expiring URL.
- Acceptance: An export of 150 customers without step-up returns 403; with it, the audit event records 150 rows; the URL expires after 5 minutes.
- Test: `test/int/mdm/master-data-export.int.spec.ts › audits row counts and demands step-up above 100 rows`

**FR-MDM-021** Price list assignment to a customer
- Actor: Sales, Manager
- Trigger: `assignCustomerPriceList`
- Rule: A customer has at most one assigned price list. Assignment is audited. A business account's list is set here and read by the engine (WHL sets it through MDM).
- Outcome: The engine uses the assigned list first.
- Acceptance: Assigning list "Caterers 2026" changes the next `resolvePrices` for that customer to the list's entry; unassigning returns to tier.
- Test: `test/int/mdm/customer-price-list.int.spec.ts › applies the assigned list first`

### 4.3 LIV: Livestock management

Default session: B6. Brief bullets: animal register (001 to 003, 017); weights and growth (004 to 006); health events, withdrawal and veterinary cost (007 to 009); breeding (010, 011); mortality and culling (012, 013); feed (014 to 016). Animals are registered by goods receipt, by birth or by opening stock; there is no free-standing "create animal" operation, so an animal cannot exist without a stock unit and a cost.

**FR-LIV-001** Individual animal register
- Actor: Storekeeper, Farm Hand
- Trigger: Goods receipt posted, birth recorded or opening stock loaded for a serialised product
- Rule: Every serialised animal is a stock unit with a tag unique among live animals, a species, breed, sex, date of birth or acquisition, source (supplier or dam), acquisition cost, current pen and status. An animal exists only through a receipt, a birth or opening stock.
- Outcome: `GET /animals` lists animals with their pen, status and accumulated cost.
- Acceptance: Receiving 20 goats against a purchase order registers 20 animals each with its own tag and a cost equal to its share of the receipt value; a second live animal with tag G-0142 is refused by a partial unique index; an archived tag can be reused only after the first animal is sold or dead.
- Test: `test/int/liv/animal-register.int.spec.ts › registers one animal per tag and refuses a duplicate live tag`

**FR-LIV-002** Animal attributes and purpose
- Actor: Farm Hand
- Trigger: `updateAnimal`
- Rule: Breed, sex, notes, purpose (`GROWING` or `BREEDING`) and photo may be edited; species, acquisition date, source and acquisition cost may not. Purpose decides cost treatment: cost is capitalised onto growing stock and expensed for breeding stock (A-025).
- Outcome: An edit is audited with before and after values.
- Acceptance: Changing sex after a birth record exists as dam returns 422; changing purpose from `GROWING` to `BREEDING` makes the next feed issue post to account 5200 instead of capitalising to 1310.
- Test: `test/int/liv/animal-edit.int.spec.ts › locks fixed attributes and applies purpose to cost treatment`

**FR-LIV-003** Move an animal between pens
- Actor: Farm Hand, Storekeeper
- Trigger: `moveAnimal`
- Rule: A move is an internal-transfer movement from the animal's current pen to the destination; an animal is in exactly one location at all times and a move starts from where it is. A hold does not block a pen-to-pen move. The move changes no cost.
- Outcome: The timeline shows the move with actor and time.
- Acceptance: Moving G-0142 from Pen 1 to Pen 2 creates one `TRANSFER_INTERNAL` movement; moving it again from Pen 1 returns 422 because it is no longer there; stock value is unchanged.
- Test: `test/int/liv/animal-move.int.spec.ts › moves a serial unit from its current location only`

**FR-LIV-004** Weight capture over time
- Actor: Farm Hand, Storekeeper
- Trigger: `recordWeights`
- Rule: A weight record has kilograms to 3 places, the capture source (`SCALE`, `MANUAL`, `ESTIMATE`), a date and an actor. Batches of weights for a pen can be submitted in one call. A dead, sold or slaughtered animal accepts no more weights.
- Outcome: Weights are append-only; a correction is a new record that supersedes the old.
- Acceptance: Recording 18.400 kg by `SCALE` succeeds; a value of 18.4004 or -1 is refused; a weight without a source is refused; a weight for an animal sold yesterday returns 422.
- Test: `test/int/liv/weight-records.int.spec.ts › requires a source and refuses records for closed animals`

**FR-LIV-005** Growth tracking and average daily gain
- Actor: Manager
- Trigger: `listGrowth`
- Rule: Average daily gain is last weight minus first weight over the calendar days between them, per animal, pen and batch, in kilograms to 3 places; pen and batch figures average over animals present for the whole window.
- Outcome: Growth is shown per animal and per group with the window used.
- Acceptance: An animal at 18.000 kg on 1 October and 24.600 kg on 31 October has ADG 0.220 kg per day; a pen of two such animals plus one added on 15 October reports ADG over the two full-window animals only.
- Test: `test/unit/liv/average-daily-gain.unit.spec.ts › computes per-animal and per-group gain`

**FR-LIV-006** Batches
- Actor: Farm Hand, Manager
- Trigger: `createBatch`, `closeBatch`
- Rule: A batch is a flock or litter managed as a group (a lot stock unit) with a start date, species, head count, pen and accumulated cost. Closing a batch needs head count zero or a documented reason.
- Outcome: A batch holds weights, feed and health records as a group.
- Acceptance: A batch of 20 broilers with 2 recorded deaths shows head count 18; closing it with 18 head returns 422; closing at 0 succeeds.
- Test: `test/int/liv/batches.int.spec.ts › closes only when empty`

**FR-LIV-007** Vaccination and treatment events
- Actor: Farm Hand
- Trigger: `recordHealthEvent`
- Rule: A health event is a vaccination or a treatment on an animal, batch or pen, with product used, dose, date, administrator, withdrawal days and cost. Medication is issued from inventory. A dead or sold animal accepts no health events.
- Outcome: Events appear on the animal timeline and the health event list.
- Acceptance: A treatment of Oxytetracycline 5 mL with 28 withdrawal days on G-0142 on 1 November creates the event, issues the medication from stock and starts a hold ending 29 November.
- Test: `test/int/liv/health-events.int.spec.ts › records treatment and issues medication from stock`

**FR-LIV-008** Withdrawal period blocks sale
- Actor: Farm Hand, Cashier, Storekeeper
- Trigger: Treatment with withdrawal days; any attempt to sell, process or send the animal out of the branch
- Rule: In the same transaction as the treatment record, a `WITHDRAWAL` hold is placed with `ends_at` computed from the withdrawal days. Sale, processing and inter-branch transfer are refused by the database while the hold is unreleased; moves between pens and write-off are allowed. A withdrawal hold cannot be released early by anyone (A-046).
- Outcome: The refusal names the hold and its end date.
- Acceptance: Selling G-0142 on 10 November returns 422 `STOCK_UNIT_ON_HOLD` with end date 29 November; releasing the hold returns 422 `WITHDRAWAL_CANNOT_BE_RELEASED`; on 29 November the sale is accepted; a direct SQL movement of type `SALE_ISSUE` is refused by the trigger.
- Test: `test/int/liv/withdrawal-hold.int.spec.ts › blocks sale and processing until the hold ends`

**FR-LIV-009** Veterinary cost capture
- Actor: Farm Hand
- Trigger: `recordHealthEvent` with cost
- Rule: Medication and veterinary service cost is added to the treated animal, batch or pen as a value-only `VETERINARY` cost movement. Cost on a pen is spread over the animals present by head-days with `allocate`; cost on a growing animal is capitalised, on a breeding animal expensed.
- Outcome: The animal's accumulated cost rises by exactly the allocated amount.
- Acceptance: A GHS 90.00 (9,000 pesewas) treatment on a pen of 3 animals with head-days 1, 1, 1 adds 3,000 to each; 9,001 adds 3,001, 3,000, 3,000 (leftover to the lowest key); the sum equals the cost recorded.
- Test: `test/unit/liv/cost-allocation.unit.spec.ts › spreads veterinary cost with no pesewa lost`

**FR-LIV-010** Breeding records
- Actor: Farm Hand
- Trigger: `createBreedingRecord`
- Rule: A breeding record names the dam (female, alive, of a breeding species), the sire where known, the mating date, and the expected birth date computed from the species' gestation days (data; seed goat 150, sheep 147, pig 114, rabbit 31, in days). A failed mating is recorded with `failBreedingRecord`.
- Outcome: The record is `MATED` until a birth or failure is recorded.
- Acceptance: A mating of dam D-017 (goat) on 1 March 2027 gives expected birth 28 July 2027; a male dam or a dead dam is refused.
- Test: `test/int/liv/breeding-record.int.spec.ts › computes expected birth and validates the dam`

**FR-LIV-011** Birth and offspring
- Actor: Farm Hand
- Trigger: `recordBirth`
- Rule: Recording a birth registers one animal per live offspring (or a batch for a clutch) with the dam linked, the actual birth date, litter or clutch size and stillbirths. Offspring enter at nil cost and accumulate from there (A-025). The dam must have been alive and female on the birth date.
- Outcome: Offspring have tags, status active and a `BIRTH` movement from the production location.
- Acceptance: A litter of 3 live and 1 stillborn kids registers 3 animals at value 0, records litter size 4, and a birth dated after the dam's death returns 422.
- Test: `test/int/liv/birth-record.int.spec.ts › registers offspring at nil cost linked to the dam`

**FR-LIV-012** Mortality and cull reporting
- Actor: Farm Hand, Storekeeper (maker); Manager (checker)
- Trigger: `reportMortality`, `submitMortalityRecord`
- Rule: A mortality or cull record has the animal or batch quantity, a reason code from the fixed list, the date, the value (accumulated cost) and an optional note. If the value is at or above the threshold (seed 50,000 pesewas) a photograph and a second approver are required before stock is written off. A cull needs a reason distinct from death.
- Outcome: Below the threshold the write-off posts on submit; at or above it returns 202 `ApprovalPending` and posts on approval.
- Acceptance: A kid with accumulated cost 12,000 posts on submit; a doe with cost 62,500 submitted without a photograph returns 422, with a photograph returns 202, and the stock stays on hand until a different user approves; an approver equal to the reporter is refused.
- Test: `test/int/liv/mortality-approval.int.spec.ts › needs photo and second approver at or above the threshold`

**FR-LIV-013** Mortality write-off to the correct expense account
- Actor: System
- Trigger: Mortality or cull posted
- Rule: Posting issues the animal's whole accumulated cost to the loss location. The ledger event debits account 5100 mortality and cull losses (the reason code's loss group `MORTALITY`) and credits 1310 live animals for the same amount.
- Outcome: Stock leaves on-hand and the expense equals the animal's cost, with nothing left in the cost pool.
- Acceptance: Writing off the doe with cost 62,500 debits 5100 62,500 and credits 1310 62,500, leaves the animal's cost pool at 0, and the trial balance still sums to zero.
- Test: `test/int/liv/mortality-posting.int.spec.ts › posts the whole accumulated cost to 5100`

**FR-LIV-014** Rations
- Actor: Farm Hand, Manager
- Trigger: `createRation`, `updateRation`
- Rule: A ration lists feed products and quantity per head per day for a species and stage. A ration is data used for planning and variance, not a stock transaction.
- Outcome: Expected consumption of a pen is ration times head-days.
- Acceptance: A ration of 0.120 kg per head per day for 10 broilers over 7 days expects 8.400 kg.
- Test: `test/unit/liv/ration-expected-consumption.unit.spec.ts › multiplies per-head quantity by head-days`

**FR-LIV-015** Feed consumption per pen
- Actor: Farm Hand
- Trigger: `recordFeedConsumption`
- Rule: A consumption record issues feed from the feed store to a pen on a date. Inventory issues the feed and values it at weighted average cost; the value is spread across the animals or batches in the pen by head-days with `allocate` as value-only `FEED` movements. The allocated amounts sum exactly to the value issued (deferred database check).
- Outcome: Each animal's or batch's accumulated cost increases.
- Acceptance: Issuing feed valued at 10,001 pesewas to a pen with head-days 10, 10 and 5 adds 4,001, 4,000 and 2,000; a deliberately inconsistent allocation of 10,000 is refused by the deferred trigger.
- Test: `test/int/liv/feed-allocation.int.spec.ts › allocates feed value to the pen exactly`

**FR-LIV-016** Feed conversion and feed cost per batch
- Actor: Manager
- Trigger: `listGrowth`, `getCostObject`
- Rule: Feed conversion ratio is kilograms of feed issued divided by kilograms of gain over the window, to 3 places; feed cost per batch is the sum of `FEED` cost elements allocated to it.
- Outcome: Both figures are available per pen and batch for any date range.
- Acceptance: A batch gaining 40.000 kg that consumed 100.000 kg of feed has FCR 2.500 and feed cost equal to the sum of its allocated feed movements.
- Test: `test/unit/liv/feed-conversion.unit.spec.ts › computes the ratio from feed and gain`

**FR-LIV-017** Animal status follows its stock unit
- Actor: System
- Trigger: Inventory records a serial unit as sold, consumed or written off
- Rule: In the same transaction, the animal's status becomes sold, slaughtered or dead. A closed animal accepts no weight, health or feed records, and cannot be sold twice.
- Outcome: The register never shows a sold animal as available.
- Acceptance: After a counter sale of G-0142 its status is `SOLD`; a second sale of G-0142 is refused by the database trigger; recording a weight for it returns 422.
- Test: `test/int/liv/animal-status.int.spec.ts › updates status in the sale transaction and refuses a second sale`

### 4.4 INV: Inventory and stock control

Default session: B5. Brief bullets: movement ledger (001 to 004); lots, traceability and cold chain (005 to 008); goods receipt, transfer, in-transit and confirmation (009 to 011); adjustments, stock take, cycle count (012 to 014); reorder and expiry alerts (015, 016); valuation (017, 018). The brief's database-enforced stock invariants are 019 to 025. INV owns reservations, holds and the value of stock (MODULE_BOUNDARIES section 4).

**FR-INV-001** Append-only stock movement ledger
- Actor: System
- Trigger: Any stock change
- Rule: Stock changes only by inserting a movement. The application role has insert and select on the movement table; triggers reject update, delete and truncate for every role. A correction is a reversing movement (FR-INV-004).
- Outcome: There is no operation that edits or deletes a movement.
- Acceptance: A direct SQL `UPDATE inv.stock_movement SET qty_base = 1` and a `DELETE` both fail with the trigger error; the contract has no update or delete operation for movements.
- Test: `test/int/inv/movement-ledger.int.spec.ts › rejects update delete and truncate of a movement`

**FR-INV-002** Movement shape
- Actor: Storekeeper, system
- Trigger: Any posting
- Rule: A movement has a type, product, stock unit where tracked, lot, quantity in base unit, weight in kg to 3 places with a source when present, a source and a destination location that differ, the source document, the actor, `occurred_at` and `recorded_at`, and a value. Quantity is positive, or zero only for value-only types. A weight without a source is refused.
- Outcome: The listing shows type, quantity, weight, lot, both locations, document, actor and time.
- Acceptance: A movement with the same source and destination is refused; quantity 0 on `SALE_ISSUE` is refused and on `COST_CAPITALISE` is accepted; weight 12.500 with no source is refused; negative quantity is refused by the check constraint.
- Test: `test/int/inv/movement-shape.int.spec.ts › enforces locations quantity and weight-source checks`

**FR-INV-003** On-hand derived from movements
- Actor: System
- Trigger: Any read of stock; nightly job
- Rule: On-hand per product and location is the sum of movements; a balance table is a projection maintained by trigger. A nightly job recomputes every balance and cost pool from the ledger; any difference raises an alert and a `BALANCE_DRIFT` stock exception with the rows, and corrects nothing.
- Outcome: `GET /stock/on-hand` returns quantity, weight, `unitCostPesewas`, `valueAtCostPesewas`, `valuationMethod`, `asOf` and a total over the whole filter.
- Acceptance: After 10 receipts and 7 sales on a product the balance is 3 from both the projection and a fresh sum of movements; corrupting a balance row by hand makes the nightly job raise one `BALANCE_DRIFT` exception and leave the row unchanged.
- Test: `test/int/inv/balance-recompute.int.spec.ts › detects drift and never auto-corrects`

**FR-INV-004** Reversal as correction
- Actor: Storekeeper (maker), Manager (checker)
- Trigger: `reverseStockMovement`
- Rule: A reversal inserts an equal and opposite movement carrying the value of the one it reverses and references it; a movement can be reversed once. A reversal needs a reason and, at or above the threshold, approval.
- Outcome: The original stays visible, linked to its reversal.
- Acceptance: Reversing a 10.000 kg receipt creates a -10.000 kg movement with the same value; a second reversal returns 422; on-hand returns to its prior figure.
- Test: `test/int/inv/movement-reversal.int.spec.ts › reverses once with the original value`

**FR-INV-005** Lots and batches
- Actor: Storekeeper
- Trigger: `postGoodsReceipt`, processing output
- Rule: A lot has a batch number unique per product, a production date, an expiry date (required for meat and eggs), a storage temperature requirement and a quantity or weight. The lot is the unit of traceability; the kilogram is the unit of sale. A lot with expiry earlier than production is refused.
- Outcome: Lots appear in the stock-unit list with dates and status.
- Acceptance: A meat lot LOT-BEEF-2026-1113 with expiry 20 November and production 13 November is accepted; expiry 12 November is refused; a duplicate batch number for the product is refused.
- Test: `test/int/inv/lots.int.spec.ts › enforces batch uniqueness and date order`

**FR-INV-006** Forward and backward traceability
- Actor: Manager, Accountant
- Trigger: `traceStockUnit`
- Rule: Tracing a sold lot or animal returns, in one call, its lineage backward (processing order, input animals, supplier, receipt, feed and veterinary cost by element) and forward (sales, customers, documents). Lineage is written as movements happen.
- Outcome: A user reaches an animal and its supplier from a sold meat lot in at most three requests.
- Acceptance: From the sold lot LOT-GOAT-0001 one `traceStockUnit` call returns animal G-0142, supplier "Nkrumah Livestock", the receipt, and cost elements FEED 8,400 and VETERINARY 3,000; the forward trace from G-0142 lists the lot and its sale order.
- Test: `test/int/inv/traceability.int.spec.ts › traces a sold lot back to the animal and supplier`

**FR-INV-007** Cold chain fields and temperature log
- Actor: Storekeeper
- Trigger: `recordTemperatureReading`
- Rule: Locations of type cold room carry a permitted range (for example 0.0 to 4.0 degrees Celsius chilled, -25.0 to -18.0 frozen). A reading has location, value to one decimal place, time and source. Readings are append-only.
- Outcome: Readings are listed per location with in-range status.
- Acceptance: A reading of 3.2 at the chilled room is in range; 6.5 is out of range and recorded as an excursion; a reading cannot be edited.
- Test: `test/int/inv/temperature-log.int.spec.ts › records readings against the location range`

**FR-INV-008** Temperature excursion quarantine
- Actor: System
- Trigger: A reading outside the location range
- Rule: In the same transaction as the reading, a `QUARANTINE` hold is placed on every lot in that location, a stock exception is raised and an event published. Release needs a named user with the permission and a reason.
- Outcome: Quarantined lots cannot be sold, processed or transferred out.
- Acceptance: A 6.5 degree reading in the chilled room quarantines its 4 lots; a counter sale of one returns 422 `STOCK_UNIT_ON_HOLD`; releasing without a reason is refused; the release is audited.
- Test: `test/int/inv/cold-chain-quarantine.int.spec.ts › quarantines every lot in the room on an excursion`

**FR-INV-009** Goods receipt
- Actor: Storekeeper
- Trigger: `createGoodsReceipt`, `postGoodsReceipt`
- Rule: A receipt names the supplier, the destination location, the purchase order where there is one, and lines with product, quantity, weight, lot data or animal tags, and unit value. Posting inserts receipt movements from the supplier location and registers the stock units. Over-receipt beyond the order tolerance is refused. A posted receipt is frozen; cancel is allowed only before posting.
- Outcome: A posted receipt shows its movements and value.
- Acceptance: Receiving 20 broilers at 5,500 pesewas each posts 20 units of value 110,000 pesewas; receiving 22 against an order for 20 with zero tolerance returns 422; editing the posted receipt is refused.
- Test: `test/int/inv/goods-receipt.int.spec.ts › posts movements and freezes the document`

**FR-INV-010** Transfers and in-transit stock
- Actor: Storekeeper
- Trigger: `createStockTransfer`, `dispatchStockTransfer`
- Rule: Dispatch moves stock from the source to the in-transit location, which belongs to the farm. In-transit stock still counts in stock value and cannot be sold. Transfers between locations of one branch change no cost; between branches the issue value moves to the receiving pool.
- Outcome: In-transit quantity is visible per transfer.
- Acceptance: Dispatching 10.000 kg from the cold room to the shop leaves the cold room at 0, in-transit at 10.000 and total stock value unchanged.
- Test: `test/int/inv/stock-transfer.int.spec.ts › moves stock through in-transit and keeps value`

**FR-INV-011** Receipt confirmation and variance at destination
- Actor: Storekeeper at destination
- Trigger: `receiveStockTransfer`
- Rule: The destination confirms what arrived. Received plus recorded variance equals dispatched. A variance needs a reason and, above the threshold, approval; the variance leaves in-transit as a loss movement.
- Outcome: The transfer closes only when received plus variance equals dispatched.
- Acceptance: Dispatched 10.000 kg, received 9.800 kg and variance 0.200 kg with reason posts 9.800 into the shop and 0.200 to loss; received 9.800 with no variance returns 422 `TRANSFER_VARIANCE`.
- Test: `test/int/inv/transfer-receipt.int.spec.ts › balances received and variance to dispatched`

**FR-INV-012** Stock adjustments with reason and approval
- Actor: Storekeeper (maker), Manager (checker)
- Trigger: `createStockAdjustment`, `submitStockAdjustment`
- Rule: An adjustment has lines, a reason code from the fixed list for each, and its total absolute value. At or above the threshold (seed 50,000 pesewas) it needs approval by a different user before posting. A posted adjustment is immutable.
- Outcome: Below the threshold it posts on submit; at or above it returns 202.
- Acceptance: An adjustment of 12 crates of eggs valued 3,500 each (42,000) posts at once; one valued 50,000 returns 202 and stock is unchanged until approved; a reason outside the list is refused.
- Test: `test/int/inv/stock-adjustment.int.spec.ts › needs approval at or above the threshold`

**FR-INV-013** Stock take workflow
- Actor: Storekeeper (counter), Manager (reviewer)
- Trigger: `createStockTake` through `submitStockTake`
- Rule: A stock take has a scope (location, categories), is started (balances frozen as the expected figure, hidden from the counter), counted, reviewed and submitted. Submitting posts a `STOCKTAKE_GAIN` or `STOCKTAKE_LOSS` movement per variance. A variance report lists expected, counted, variance quantity and value. Variance value at or above the threshold needs approval.
- Outcome: Movements during counting do not alter the frozen expected figure; the report is exportable.
- Acceptance: Expected 12 crates, counted 11: variance -1 crate valued 3,500 posts a loss of 3,500; the counter never sees "12" before submitting counts.
- Test: `test/int/inv/stock-take.int.spec.ts › posts variances from blind counts`

**FR-INV-014** Cycle count
- Actor: Storekeeper
- Trigger: `createStockTake` with a partial scope
- Rule: A cycle count is a stock take with a partial scope (a location, a category or a list of products). A schedule setting proposes which scope is due. The count of each scope is dated for the trend of variances.
- Outcome: Cycle counts of different scopes can run in parallel without overlapping products.
- Acceptance: A cycle count of "Cold room, beef" runs while another of "Pen 2, goats" runs; starting a second count that includes beef returns 422.
- Test: `test/int/inv/cycle-count.int.spec.ts › refuses overlapping scopes`

**FR-INV-015** Reorder points and low-stock alerts
- Actor: Storekeeper, Manager
- Trigger: `createReorderRule`, `listStockAlerts`
- Rule: A rule per product and location has a reorder point, minimum and maximum. When available stock falls to or below the reorder point an alert is raised once (not per movement) with the suggested quantity to reach the maximum.
- Outcome: Alerts appear in `GET /stock/alerts` and as a notification event.
- Acceptance: Rule: reorder point 20, maximum 100 bags of feed; available drops from 21 to 19: one alert suggesting 81; a further sale to 18 raises no second alert until stock rises above 20 and falls again.
- Test: `test/int/inv/reorder-alerts.int.spec.ts › raises one alert per crossing`

**FR-INV-016** Expiring-stock alerts
- Actor: System
- Trigger: Daily job
- Rule: Lots with expiry within a configurable number of days (seed 3) raise an expiring alert; expired lots are blocked from sale and flagged for write-off.
- Outcome: Alerts list the lot, quantity and days left.
- Acceptance: A lot expiring 16 November raises an alert on 13 November; on 17 November a sale of it is refused.
- Test: `test/int/inv/expiry-alerts.int.spec.ts › alerts before expiry and blocks sale after`

**FR-INV-017** Weighted average cost valuation
- Actor: System
- Trigger: Any receipt or issue of an untracked product or lot
- Rule: An untracked product holds a pool of quantity and value per branch. An issue of q from a pool of Q and value V carries `half_up(V x q / Q)`, and the issue that empties the pool carries all the remaining value. A transfer within a branch changes no pool.
- Outcome: Stock value equals the sum of pools and ties to the ledger.
- Acceptance: A pool of 3 units valued 100,001: issuing 1 carries 33,334 (pool 2 units, 66,667); issuing 1 carries 33,334 (pool 1 unit, 33,333); issuing the last carries 33,333; total 100,001.
- Test: `test/unit/inv/weighted-average-cost.unit.spec.ts › issues with half-up and empties the pool exactly`

**FR-INV-018** Specific identification for animals
- Actor: System
- Trigger: Sale, death or processing of a serial unit
- Rule: A serialised animal has quantity one and carries its own whole accumulated cost on any issue. Cost accumulates from purchase and from value-only feed, veterinary, labour and overhead movements.
- Outcome: The cost of sales for an animal is its own accumulated cost.
- Acceptance: G-0142 bought at 60,000 with 8,400 feed and 3,000 veterinary cost is sold with cost of sales 71,400; another animal's cost is unaffected.
- Test: `test/int/inv/specific-identification.int.spec.ts › issues the animal's own accumulated cost`

**FR-INV-019** Stock cannot go negative except where allowed
- Actor: System
- Trigger: An outbound movement
- Rule: Stock at a physical location cannot go negative except through a movement type and location that both allow it (seed: `SALE_ISSUE_OFFLINE` at sellable locations, for untracked and lot stock). Each such case raises a stock exception. If the uncovered quantity has no cost, it carries zero value and the exception states that cost of sales is understated.
- Outcome: A refusal names the product, location and shortfall.
- Acceptance: Selling 5 crates from a balance of 3 with `SALE_ISSUE` is refused by the trigger; the same sale synced from an offline device with `SALE_ISSUE_OFFLINE` posts, leaves a balance of -2 and raises one stock exception.
- Test: `test/int/inv/negative-stock.int.spec.ts › refuses except for allowed offline movements`

**FR-INV-020** A serialised animal is in one place and sells once
- Actor: System
- Trigger: Sale, transfer or processing of a serial unit
- Rule: A serial unit has exactly one current location and a movement must start from it. It cannot be sold twice, cannot be sold or processed under an unreleased hold, and selling and placing a hold lock the same row so the rule holds at any isolation level.
- Outcome: The second of two concurrent sales fails.
- Acceptance: Two cashiers selling G-0142 concurrently: one sale posts, the other receives 422 and the animal's movements show exactly one `SALE_ISSUE`; a movement from a location the animal is not in is refused.
- Test: `test/int/inv/serial-unit.int.spec.ts › allows exactly one concurrent sale`

**FR-INV-021** Reservations
- Actor: System
- Trigger: Checkout start, order confirmation, quote issue
- Rule: A reservation promises stock to a document with an expiry. Reserved cannot exceed on-hand; at most one active reservation exists per serial unit; an outbound movement naming its reservation consumes it, and any other outbound movement cannot dip below reserved. Available to promise is on-hand minus reserved minus held. Defaults: 15 minutes for checkout (A-045), the quote's validity for a quote, until fulfilment for a confirmed order. Expired reservations are released by a scheduled job.
- Outcome: `GET /stock/availability` shows available per product and location.
- Acceptance: Reserving goat G-0142 for checkout C1 and then for C2 returns 422 on the second; 16 minutes later the job releases C1's reservation and publishes `ReservationExpired`; reserving 4 of 3 on-hand crates is refused.
- Test: `test/int/inv/reservations.int.spec.ts › allows one active reservation per animal and expires on time`

**FR-INV-022** Holds
- Actor: Manager, system
- Trigger: `createStockHold`, `releaseStockHold`
- Rule: A hold has kind `WITHDRAWAL`, `QUARANTINE` or `INVESTIGATION`, a start, an end or none, and the source document. Sale, processing and transfer out of the branch are blocked while unreleased; pen moves and write-off are not. A hold is released once, by a named user with a reason, except a `WITHDRAWAL` hold which only ends by time.
- Outcome: Holds are listed with their effect.
- Acceptance: An `INVESTIGATION` hold on lot L7 blocks its sale and is released by the manager with a reason; a second release returns 422; a withdrawal hold release returns 422.
- Test: `test/int/inv/stock-holds.int.spec.ts › blocks listed movement types until released`

**FR-INV-023** Stock exception queue
- Actor: Manager
- Trigger: `listStockExceptions`, `resolveStockException`
- Rule: A stock exception records a conflict (negative stock, animal not where the sale said, hold violation, balance drift, unit-cost gap) with the product, unit, causing document, the two conflicting facts and a status. Resolving needs a resolution kind and note, posts any correcting adjustment through the normal approval path, and is audited.
- Outcome: Open exceptions appear on the daily exception report as `STOCK_EXCEPTION`.
- Acceptance: An offline sale of an animal already sold creates a `STOCK_EXCEPTION` item; resolving it by writing off the sale's stock line posts a reversing movement and closes it.
- Test: `test/int/inv/stock-exceptions.int.spec.ts › records resolves and reports a conflict`

**FR-INV-024** Numeric and referential integrity
- Actor: System
- Trigger: Any write
- Rule: Money columns are non-negative `BIGINT` pesewas up to 9,007,199,254,740,991; weights `NUMERIC(10,3)`; quantities `NUMERIC(14,3)`; every foreign key is declared; no orphan rows.
- Outcome: Out-of-range or malformed values fail at the database even if the application is bypassed.
- Acceptance: Inserting a movement with a weight of 1000000.000 kg, a negative value, or a product id that does not exist each fails with a constraint error.
- Test: `test/int/inv/numeric-constraints.int.spec.ts › rejects out-of-range values at the database`

**FR-INV-025** Serializable reservation and posting with retry
- Actor: System
- Trigger: Concurrent reservations or sale postings
- Rule: Reservation and ledger posting run at serializable isolation and retry on serialisation failure up to a bounded count; a session lock is taken before the transaction begins (ADR-0005, A-060). Everything else runs at read committed. Aggregates carry a version column and updates send the version read.
- Outcome: Concurrent writers get a correct result or a 409 `VERSION_CONFLICT`, never a lost update.
- Acceptance: 50 concurrent reservations for the last 10 units yield exactly 10 successes and 40 refusals; two updates with the same `version` yield one success and one 409.
- Test: `test/int/inv/serializable-reservation.int.spec.ts › yields exactly the available quantity under contention`

### 4.5 PRC: Processing and production

Default session: B6. Brief bullets: processing orders (001 to 003, 011); yield and variance flag (004, 005); cost allocation by relative sales value (006 to 008); packing, labels and barcodes (009, 010).

**FR-PRC-001** Create and start a processing order
- Actor: Farm Hand, Storekeeper
- Trigger: `createProcessingOrder`, `startProcessingOrder`
- Rule: An order names the location, the date and its inputs: live animals or raw carcasses (stock units) with weight at input. An input under an unreleased hold, already sold, or not at the location cannot be added or started.
- Outcome: The order moves from `DRAFT` to `IN_PROGRESS`; inputs are shown with their accumulated cost.
- Acceptance: Starting an order that includes G-0142 while its withdrawal hold is active returns 422 `STOCK_UNIT_ON_HOLD`; an animal already sold is refused; a valid goat is accepted.
- Test: `test/int/prc/processing-start.int.spec.ts › refuses held sold or absent inputs`

**FR-PRC-002** Record outputs
- Actor: Farm Hand, Storekeeper
- Trigger: `recordProcessingOutputs`
- Rule: Outputs are meat lots (with batch number, production date, expiry and storage temperature), offal, by-products and waste, each with weight and a reference sale price per kilogram snapshotted at completion. Total output weight cannot exceed total input weight.
- Outcome: Outputs are listed with weights and kinds.
- Acceptance: Input 28.000 kg: outputs of meat 14.000, offal 3.000, by-products 2.000 and waste 9.000 (total 28.000) are accepted; waste 9.001 is refused.
- Test: `test/unit/prc/processing-outputs.unit.spec.ts › refuses output weight above input weight`

**FR-PRC-003** Complete an order
- Actor: Farm Hand, Manager
- Trigger: `completeProcessingOrder`
- Rule: Completion, in one transaction, consumes every input (process-consume movements to the processing location), creates the output lots (process-output movements into the cold room), records lineage from every output to every input, and freezes the order.
- Outcome: Output lots exist with cost and lineage; the animals are no longer on hand.
- Acceptance: After completing the goat order the animal is `CONSUMED`, three lots exist, and `traceStockUnit` on any output returns the animal; a second completion returns 422.
- Test: `test/int/prc/processing-complete.int.spec.ts › consumes inputs and creates linked output lots`

**FR-PRC-004** Expected and actual yield
- Actor: Manager
- Trigger: `createYieldStandard`; completion
- Rule: A yield standard gives expected yield as a percentage of input weight per species and output kind. The order records expected and actual yield per output and overall to 3 decimals.
- Outcome: Expected, actual and variance appear on the order.
- Acceptance: Standard goat meat yield 50.000 percent of 28.000 kg expects 14.000 kg; actual 12.600 kg is 45.000 percent, a variance of -1.400 kg.
- Test: `test/unit/prc/yield.unit.spec.ts › computes expected actual and variance`

**FR-PRC-005** Yield variance investigation flag
- Actor: System
- Trigger: Completion with variance beyond tolerance
- Rule: When actual differs from expected by more than 5 percent of expected (SA-07), the order carries an investigation flag, an event is published and the daily exception report shows `YIELD_VARIANCE` with the order, the actor and the weights.
- Outcome: The flag does not block completion and does not post a separate ledger figure (BL-007).
- Acceptance: Actual 12.600 against expected 14.000 is a 10 percent shortfall and is flagged; 13.400 (4.3 percent) is not; the report item lists `abuseCases` containing 18.
- Test: `test/int/prc/yield-variance.int.spec.ts › flags beyond five percent and reports it`

**FR-PRC-006** Direct processing cost
- Actor: Manager
- Trigger: `addProcessingCost`
- Rule: Direct cost (labour, utilities, packaging) is added to the order in pesewas with a cost element and posted to the order's work in progress.
- Outcome: Direct cost is part of the amount allocated at completion.
- Acceptance: Adding 5,000 pesewas of direct cost to an order with input cost 71,400 makes the total to allocate 76,400.
- Test: `test/int/prc/processing-cost.int.spec.ts › adds direct cost to the total to allocate`

**FR-PRC-007** Cost allocation by relative sales value
- Actor: System
- Trigger: Completion
- Rule: Total cost is input cost (sum of consumed units' pools) plus direct cost. Each output's weight for allocation is its weight in grams multiplied by its reference sale price per kilogram; waste has weight zero. `allocate` splits the total, giving leftover pesewas to the largest remainders, ties to the lowest output number. A deferred trigger asserts the allocated values sum to the total.
- Outcome: Each output lot's cost pool starts at its allocated value.
- Acceptance: Total 76,400 over meat (14,000 g at 4,000 per kg), offal (3,000 g at 1,500) and by-products (2,000 g at 500) allocates 69,568, 5,590 and 1,242 (sum 76,400); allocating 69,567, 5,590 and 1,242 (sum 76,399) is refused by the deferred trigger.
- Test: `test/unit/prc/cost-allocation.unit.spec.ts › allocates processing cost by relative sales value exactly`

**FR-PRC-008** Waste carries no cost
- Actor: System
- Trigger: Completion
- Rule: Waste outputs are recorded with weight and no cost; the cost they would have carried is absorbed by the saleable outputs through the allocation.
- Outcome: Waste lots hold value 0.
- Acceptance: In the 28.000 kg example, 9.000 kg of waste has cost 0 and the saleable outputs carry all 76,400.
- Test: `test/unit/prc/waste-cost.unit.spec.ts › gives waste zero cost`

**FR-PRC-009** Packing into standard pack sizes
- Actor: Storekeeper
- Trigger: `createPacks`
- Rule: Packs are weighed pieces of a meat lot, normally of the nominal pack size (15.000 kg), each with its own weight and weight source. Pack weights sum to the lot weight within a tolerance of 0.000 kg unless a remainder pack is recorded.
- Outcome: Packs are listed with lot, weight and status.
- Acceptance: Lot of 44.600 kg packed as 15.000, 15.000 and 14.600 sums to 44.600; recording packs summing to 44.700 is refused.
- Test: `test/int/prc/packing.int.spec.ts › keeps pack weights equal to the lot weight`

**FR-PRC-010** Labels and barcodes carrying lot and weight
- Actor: Storekeeper
- Trigger: `printPackLabels`
- Rule: Each pack label shows product, batch number, production and expiry dates, storage temperature and weight in kg, and a barcode whose payload encodes the lot and the weight in grams, so the counter can sell the pack without a scale. Reprinting yields the same payload.
- Outcome: Scanning a label at the counter adds the pack to the sale at its weighed quantity.
- Acceptance: A pack of 15.200 kg in lot LOT-BEEF-2026-1113 produces payload `LOT-BEEF-2026-1113/015200`; scanning it adds a line of 15.200 kg; a second scan of the same pack is refused.
- Test: `test/unit/prc/pack-label.unit.spec.ts › encodes lot and weight in the barcode payload`

**FR-PRC-011** A completed order is frozen
- Actor: Manager
- Trigger: Cancel or correct an order
- Rule: An `IN_PROGRESS` order may be cancelled with no stock effect. A `COMPLETED` order cannot be edited; a mistake is corrected by a reversing order that reverses its movements.
- Outcome: Reversal restores inputs and removes outputs only if the outputs are unsold.
- Acceptance: Editing a completed order is refused by the database; reversing it when an output lot is partly sold returns 422; reversing it when unsold restores the animal to its pen at its prior cost.
- Test: `test/int/prc/processing-freeze.int.spec.ts › refuses edits and reverses only unsold outputs`

### 4.6 PUR: Procurement and suppliers

Default session: B7. Brief bullets: supplier register (001 to 003); requisition, purchase order, partial receipt and three-way match (004 to 010); supplier invoice, credit notes, payment scheduling, remittance (008, 011 to 013); supplier scoring (014). Ledger postings (015) are proven in B8 when the ledger exists.

**FR-PUR-001** Supplier profile
- Actor: Manager, Accountant
- Trigger: `updateSupplierProfile`
- Rule: A profile holds payment terms (days), categories supplied, contact persons, and bank or mobile money payout details. Identity (name, phone, address) belongs to master data.
- Outcome: The profile is returned with payout details masked.
- Acceptance: Setting terms of 14 days is returned as 14; the account number appears only as the last 4 characters.
- Test: `test/int/pur/supplier-profile.int.spec.ts › stores terms and masks payout details`

**FR-PUR-002** Payout details are encrypted and changes need a second person
- Actor: Accountant (maker), Owner or Accountant other than the maker (checker)
- Trigger: `updateSupplierProfile` with changed payout details
- Rule: Payout details are column-encrypted (ADR-0022) and decrypted only for a user with the specific permission; each decryption is audited. A change to them returns 202 `ApprovalPending` (kind `SUPPLIER_PAYOUT_CHANGE`) and takes effect only on approval by a different user.
- Outcome: The old details stay in force until approval; the change appears on the payout change report.
- Acceptance: Changing a mobile money number returns 202 and a payment prepared that day still uses the old number; the stored column is ciphertext in a database dump.
- Test: `test/int/pur/payout-details.int.spec.ts › encrypts and requires a second approver for a change`

**FR-PUR-003** Supplier documents
- Actor: Manager
- Trigger: `addSupplierDocument`
- Rule: Documents (licence, health certificate, contract) are stored privately through the file store with type, expiry date and an expiry reminder.
- Outcome: They are served only by signed, expiring URLs, each issue logged.
- Acceptance: Uploading a PDF with a `.pdf` name that is an executable is refused; the download URL expires after 5 minutes.
- Test: `test/int/pur/supplier-documents.int.spec.ts › stores privately and refuses disguised files`

**FR-PUR-004** Purchase requisition
- Actor: Storekeeper, Farm Hand
- Trigger: `createPurchaseRequisition`, `submitPurchaseRequisition`
- Rule: A requisition lists products, quantities and a needed-by date. A manager approves it, rejects it with a reason, or converts it into a purchase order.
- Outcome: The requisition moves `DRAFT`, `SUBMITTED`, `CONVERTED` or `REJECTED`.
- Acceptance: Submitting a requisition for 20 broilers and converting it creates a purchase order linked to it; a rejected one cannot be converted.
- Test: `test/int/pur/requisitions.int.spec.ts › converts or rejects a submitted requisition`

**FR-PUR-005** Purchase order with approval limits
- Actor: Storekeeper or Manager (maker), Manager (checker)
- Trigger: `createPurchaseOrder`, `submitPurchaseOrder`
- Rule: A purchase order has a supplier, lines (product, quantity, unit price, levies), expected date and terms. A total above the requester's limit (seed above 200,000 pesewas) needs approval by a different user; the database refuses a sent order above the limit without an approval id.
- Outcome: Below the limit the order is approved on submit; above it returns 202.
- Acceptance: An order for 20 broilers at 5,500 (110,000) is approved on submit; an order of 250,000 returns 202 and cannot be sent; the requester approving their own order is refused.
- Test: `test/int/pur/purchase-order-approval.int.spec.ts › needs a second approver above the limit`

**FR-PUR-006** Send, close and cancel an order
- Actor: Manager
- Trigger: `sendPurchaseOrder`, `closePurchaseOrder`, `cancelPurchaseOrder`
- Rule: An approved order is sent to the supplier as an archived document. It can be closed when fully received or short-closed with a reason, and cancelled only before any receipt.
- Outcome: The status follows `DRAFT`, `APPROVED`, `SENT`, `PART_RECEIVED`, `RECEIVED`, `CLOSED`, `CANCELLED`.
- Acceptance: Cancelling after a partial receipt returns 422; short-closing an order with 15 of 20 received closes it with 5 outstanding recorded.
- Test: `test/int/pur/purchase-order-lifecycle.int.spec.ts › cancels only before receipt`

**FR-PUR-007** Partial receipt against an order
- Actor: Storekeeper
- Trigger: `postGoodsReceipt` naming an order line
- Rule: Each receipt reduces the order line's outstanding quantity. Total received cannot exceed ordered plus the tolerance (seed 0). A short delivery keeps the order open.
- Outcome: The order shows ordered, received and outstanding per line.
- Acceptance: Order 20: receiving 12 leaves 8 outstanding and status `PART_RECEIVED`; receiving 9 more is refused; receiving 8 completes it.
- Test: `test/int/pur/partial-receipt.int.spec.ts › tracks outstanding and refuses over-receipt`

**FR-PUR-008** Supplier invoice capture
- Actor: Accountant
- Trigger: `createSupplierInvoice`
- Rule: An invoice has the supplier's invoice number (unique per supplier), date, due date from terms, lines tied to order lines or receipts, and levy rows snapshotted with their reclaimable flag. Totals equal the sum of lines.
- Outcome: The invoice is `DRAFT` until matched.
- Acceptance: A second invoice number INV-0088 from the same supplier is refused; the same number from another supplier is accepted; lines whose sum differs from the total are refused.
- Test: `test/int/pur/supplier-invoice.int.spec.ts › refuses a duplicate number per supplier`

**FR-PUR-009** Three-way match
- Actor: System
- Trigger: `matchSupplierInvoice`
- Rule: Each invoice line is compared with the order line and the receipt. It matches when quantity does not exceed the quantity received and the unit price is within 1 percent of the order price (SA-08). The result is per line with the reason.
- Outcome: The invoice is `MATCHED` only if every payable line matches.
- Acceptance: Order 20 at 5,500, received 20, invoice 20 at 5,550 (0.91 percent) matches; invoice 20 at 5,600 (1.82 percent) mismatches on price; invoice 22 mismatches on quantity.
- Test: `test/unit/pur/three-way-match.unit.spec.ts › applies the price and quantity tolerances`

**FR-PUR-010** A mismatch blocks payment
- Actor: Accountant, Owner
- Trigger: `approveSupplierInvoice`, `createSupplierPayment`
- Rule: A line that does not match cannot be approved or allocated to a payment; the database checks `match_status` before an allocation. An accountant may resolve a mismatch by correcting the invoice, receiving the goods, or an approved variance.
- Outcome: Payment of an unmatched invoice returns 422 `THREE_WAY_MATCH_FAILED`.
- Acceptance: Allocating a payment to the 5,600 invoice returns 422; after an approved variance it is allowed; direct SQL allocation to an unmatched invoice is refused.
- Test: `test/int/pur/payment-block.int.spec.ts › refuses payment of an unmatched invoice`

**FR-PUR-011** Supplier credit notes
- Actor: Accountant
- Trigger: `createSupplierInvoice` with kind credit note
- Rule: A credit note references the invoice it reduces and cannot exceed its uncredited amount. Credits reduce the payable and, where goods are returned, issue a supplier-return movement.
- Outcome: The credit is allocated to the invoice's outstanding amount.
- Acceptance: A credit of 11,000 against a 110,000 invoice leaves 99,000 payable; a second credit of 100,000 is refused.
- Test: `test/int/pur/supplier-credit-note.int.spec.ts › cannot exceed the invoice`

**FR-PUR-012** Payment scheduling and supplier payment
- Actor: Accountant (maker), Owner or Manager (checker)
- Trigger: `createSupplierPayment`, `submitSupplierPayment`, `markSupplierPaymentPaid`
- Rule: A supplier payment is scheduled for a date, allocates to invoices (never more than the payment or the invoice's outstanding amount) and is approved by a different user before it can be marked paid. Marking paid records the method and reference.
- Outcome: The invoice shows paid and outstanding amounts.
- Acceptance: Paying 110,000 across two invoices of 60,000 and 50,000 allocates exactly; allocating 110,001 is refused; the preparer approving is refused.
- Test: `test/int/pur/supplier-payment.int.spec.ts › allocates within limits with a second approver`

**FR-PUR-013** Remittance advice
- Actor: System
- Trigger: A supplier payment marked paid
- Rule: A remittance advice listing invoices paid, amounts and the payment reference is rendered, archived and queued to the supplier by the notification module.
- Outcome: The supplier receives one advice per payment; replays send nothing twice.
- Acceptance: Marking a payment paid twice produces one remittance document and one message.
- Test: `test/int/pur/remittance.int.spec.ts › sends one advice per payment`

**FR-PUR-014** Supplier performance scoring
- Actor: Manager
- Trigger: `listSupplierScores`
- Rule: A score from 0 to 100 combines price (against the average paid for the product), lead time (promised against actual), quality (accepted share of received quantity) and rejection rate, with weights 30, 25, 25 and 20 held as settings.
- Outcome: Scores are listed per supplier and period with their components.
- Acceptance: Components price 90, lead time 80, quality 100 and rejection (100 minus 5 percent) 95 give 0.30 x 90 + 0.25 x 80 + 0.25 x 100 + 0.20 x 95 = 91.0.
- Test: `test/unit/pur/supplier-score.unit.spec.ts › combines the four components with weights`

**FR-PUR-015** Purchase postings
- Actor: System
- Trigger: Receipt posted; supplier invoice matched; payment made
- Rule: A receipt against an order debits inventory and credits goods received not invoiced (2010). A matched invoice clears 2010, credits trade payables (2000) with the supplier as subledger, and debits recoverable levies (1400) for reclaimable levies. A price difference within tolerance posts to purchase price variance (5140), not onto the stock (A-027). A payment debits payables and credits bank.
- Outcome: Each event produces one balanced journal.
- Acceptance: Receipt 110,000 then invoice at 111,000 with reclaimable levies 0: 2010 debited 110,000, 5140 debited 1,000, 2000 credited 111,000; the trial balance sums to zero.
- Test: `test/int/pur/purchase-posting.int.spec.ts › posts receipt invoice and price variance`

### 4.7 POS: Retail point of sale

Default session: B9b. A counter sale is a sales order on channel `POS` placed and completed in one step by the order module (DOMAIN_MODEL 5.11); the order core and sale posting are built in B9a and the POS requirements that depend on them are proven in B9b. Brief bullets: fast counter sale and weight (001 to 003); split tender (005, 006); price override (004); hold, recall, returns, void (007 to 009); offline mode (010 to 014); shifts, X and Z, blind close, over and short (015 to 020); receipts (021, 022).

**FR-POS-001** Fast counter sale
- Actor: Cashier
- Trigger: `completeCounterSale`
- Rule: The cashier adds items by barcode, search or category tile. In one serializable transaction the server re-resolves every price, issues stock (a goat by tag, eggs by crate, beef by weight), issues the receipt with its gap-free number, records and allocates the tenders and posts the ledger. A sale belongs to the cashier's own open shift.
- Outcome: 201 with the order, receipt number and tenders, or nothing at all.
- Acceptance: Selling goat G-0142 at 85,000 and 2 crates of eggs at 4,500 (total 94,000, zero-rated) writes 1 animal movement, 2 egg movements, receipt `RCP-2026-ACC-T1-000001`, tenders and journal in one transaction; a failure in the ledger step leaves no movement, no receipt number consumed and no payment.
- Test: `test/int/pos/counter-sale.int.spec.ts › posts stock receipt payment and ledger atomically`

**FR-POS-002** Weight capture per item
- Actor: Cashier
- Trigger: A catch-weight item added
- Rule: Each catch-weight line captures weight in kilograms to 3 places with a source (`SCALE` from a connected scale, `MANUAL`, `ESTIMATE`). The line total is `half_up(price per kg x weight)`. A pack with a label barcode supplies its weighed weight (FR-PRC-010).
- Outcome: The line shows the weight and its source; the manual-weight rate by user is reportable.
- Acceptance: 0.201 kg at 2,500 per kg is 502.5, rounded half-up to 503 pesewas; 15.200 kg at 2,800 per kg is 42,560; a weight of 0, a negative or 15.2004 is refused; a line without a source is refused.
- Test: `test/unit/pos/catch-weight-line.unit.spec.ts › rounds half-up once at the line total`

**FR-POS-003** Price at the counter
- Actor: Cashier
- Trigger: An item is added
- Rule: The price is resolved by the engine for channel `POS`, the customer if attached, the weight and time. A price that does not resolve cannot be added; the cashier raises a counter quote, a user with quoting authority prices and approves it, and the accepted quote converts to the sale.
- Outcome: A resolved line shows list price and rule; an unresolved one shows "quote required".
- Acceptance: A goat with no weight returns `QUOTE_REQUIRED` and cannot be added; adding a product in `REQUEST_TO_BUY` online mode at the counter is allowed because the counter sells live animals per head by tag.
- Test: `test/int/pos/counter-pricing.int.spec.ts › refuses an unresolved price and offers a quote`

**FR-POS-004** Price override within role limit
- Actor: Cashier, Sales, Manager
- Trigger: A line's agreed price differs from list
- Rule: An agreed price between floor and ceiling and within the user's limit for the line and the shift (seed cashier 5 percent per line and 10,000 pesewas per shift) needs a mandatory reason from the fixed list and is recorded as a variance posted to account 4210. Beyond the limit, or outside floor and ceiling, the sale is refused with 422 `PRICE_OVERRIDE_NEEDS_APPROVAL` until a different user approves.
- Outcome: The variance appears on the line, the shift's override total and the daily exception report.
- Acceptance: Goat list 90,000, cashier agrees 86,000 (4,000, 4.4 percent) with reason: accepted, 4210 debited 4,000; then agreeing 84,000 on another line takes the shift total to 10,000 (accepted) and one more 1-pesewa variance is refused; an override with no reason is refused.
- Test: `test/int/pos/price-override.int.spec.ts › applies line and shift limits and posts to 4210`

**FR-POS-005** Split tender, change and store credit
- Actor: Cashier
- Trigger: Tenders added
- Rule: A sale may be paid by any mix of cash, mobile money, card and store credit. The tenders must sum to at least the total; only cash may exceed it, and the excess is change. Store credit cannot exceed the customer's balance. Every tender is an exact integer.
- Outcome: The receipt lists each tender and change.
- Acceptance: Total 94,000: mobile money 50,000 (verified) plus cash 50,000 gives change 6,000 and a cash retained amount of 44,000; tenders totalling 93,999 are refused; mobile money 95,000 is refused because only cash gives change.
- Test: `test/unit/pos/tender-allocation.unit.spec.ts › requires tenders to cover the total and limits change to cash`

**FR-POS-006** Mobile money and card are recorded only when verified
- Actor: Cashier
- Trigger: A mobile money or card tender
- Rule: No screen or operation accepts "paid" on the cashier's word. The tender is a pending payment until a verified provider callback or a provider status lookup confirms it (FR-PAY-005); the sale completes when the tender clears. A client-supplied cleared status is refused.
- Outcome: A pending tender holds the sale open; a timed-out tender is cancelled.
- Acceptance: A request body carrying `status: CLEARED` for a mobile money tender returns 422 `PAYMENT_METHOD_REQUIRES_VERIFICATION`; after the verified callback the same sale completes.
- Test: `test/int/pos/verified-tender.int.spec.ts › refuses a client-asserted cleared mobile money tender`

**FR-POS-007** Hold and recall sales
- Actor: Cashier
- Trigger: `holdSale`, `recallHeldSale`
- Rule: A sale in progress can be parked on the register and recalled by any cashier with the open shift on that register. Held animals are not reserved against other sales until the sale completes, except where the setting reserves them; a recalled sale is re-priced.
- Outcome: Held sales are listed per register; a recalled sale leaves the hold list.
- Acceptance: Holding a sale and recalling it after a price list change re-prices the lines; recalling it twice returns 404 the second time.
- Test: `test/int/pos/held-sales.int.spec.ts › holds recalls and re-prices`

**FR-POS-008** Returns and exchanges against the original receipt
- Actor: Cashier (maker), Manager (checker above limit)
- Trigger: `createReturn`, `submitReturn`
- Rule: A return references the original order and lines and cannot exceed what was sold less what was already returned. Returned stock goes to the returns holding location, not to saleable stock until inspected. A refund goes to the original tender method and is approved above the automatic limit (seed 20,000 pesewas). An exchange is a return plus a new sale.
- Outcome: A credit note is issued for the returned lines.
- Acceptance: Returning 1 of 2 crates of eggs (4,500) refunds 4,500 to the original method; returning a third crate is refused; a return with no original receipt is refused; a 25,000 refund returns 202 until approved.
- Test: `test/int/pos/return-against-receipt.int.spec.ts › cannot exceed the quantity sold`

**FR-POS-009** Void with supervisor approval
- Actor: Cashier (maker), Supervisor or Manager (checker)
- Trigger: `voidOrder` on a completed sale
- Rule: A completed sale can be voided only within the same shift, with a reason, and only after approval by a supervisor who is not the cashier (database check). A void reverses stock, the billing document (by a credit note) and payment as far as each had gone, and leaves the original order and the void as an immutable record.
- Outcome: The order moves to `VOIDED`; the daily exception report shows `SALE_VOID`.
- Acceptance: Voiding receipt RCP-2026-ACC-T1-000001 returns 202; approval by the cashier is refused; approval by a supervisor reverses the goat and egg movements, issues credit note `CRN-2026-ACC-000001`, and refunds the tenders; a void in the next shift is refused.
- Test: `test/int/pos/sale-void.int.spec.ts › needs a different supervisor and reverses stock billing and payment`

**FR-POS-010** Offline pack and offline sale
- Actor: Cashier, POS device
- Trigger: `getOfflinePack`; a sale made with no connection
- Rule: A register device is enrolled by a manager and holds a device credential. Offline, the cashier unlocks the device with a PIN against a locally cached open shift. The pack carries cached prices, products, role limits and an age. An offline sale carries a client UUIDv7 as its identity, a device counter and a provisional reference `P-<REGISTER>-<SHIFT SEQUENCE>-<DEVICE COUNTER>`; tenders are cash only (A-041). The device operates for 8 hours and queues at least 500 sales.
- Outcome: The device prints a provisional receipt with a QR code of the sale id and states that the official number follows.
- Acceptance: An offline mobile money tender is refused on the device; the 501st queued sale is accepted; the queue survives a device restart.
- Test: `test/e2e/pos/offline-counter.e2e.spec.ts › runs 8 hours offline and queues 500 cash sales`

**FR-POS-011** Sync exactly once
- Actor: POS device
- Trigger: `syncOfflineSales`
- Rule: Each queued sale is posted by the normal sale transaction, identified by its client id; a resend is a no-op that returns the first result. A sale that passes authentication and integrity is always recorded; the official receipt number is allocated at sync. The server re-checks every permission and price rule; it is authoritative.
- Outcome: The response lists per sale: posted, duplicate, or posted with an exception.
- Acceptance: Sending the same batch of 50 sales 3 times produces 50 orders, 50 receipts and 50 `sale_sync` rows with outcomes `POSTED` then `DUPLICATE`; a unique index on the client id refuses a direct duplicate insert.
- Test: `test/int/pos/offline-sync.int.spec.ts › posts each client id exactly once`

**FR-POS-012** Conflict rules for offline stock
- Actor: POS device, system
- Trigger: A synced sale conflicts with stock
- Rule: A countable or lot product may go negative on sync through the offline movement type and raises a stock exception each time. A serialised animal that is no longer where the sale says is never moved twice: the order line is posted with no movement and a stock exception names the conflict. The money and receipt are recorded in both cases.
- Outcome: Nothing is resolved silently; every exception names cashier, register, shift and the two conflicting facts.
- Acceptance: Offline sale of 5 crates with 3 on hand posts and leaves -2 with one `STOCK_EXCEPTION`; an offline sale of G-0142 already sold online posts the order and payment, records no second animal movement and raises an exception.
- Test: `test/int/pos/offline-conflicts.int.spec.ts › flags stock conflicts instead of failing or hiding them`

**FR-POS-013** Device counter gap detection
- Actor: System
- Trigger: Sync of a shift's sales
- Rule: Each device keeps a gap-free counter per shift. At sync the server compares counters; a missing value raises a `DEVICE_COUNTER_GAP` exception naming the register, shift and the missing numbers.
- Outcome: A gap is visible the same day.
- Acceptance: A batch with counters 1 to 10 omitting 7 syncs 9 sales and raises one exception listing 7; deleting a sale from the device before sync cannot go undetected.
- Test: `test/int/pos/device-counter.int.spec.ts › raises an exception for a missing counter`

**FR-POS-014** Offline overrides and late sales
- Actor: System
- Trigger: Sync of a sale with an override or an old `occurred_at`
- Rule: An offline override is bounded by the cached role limit and re-checked at sync; one beyond the server's limit is posted and raised as an exception for approval after the fact. A sale whose `occurred_at` falls in a locked period or after the shift was force-closed posts on the first open date, is flagged, and keeps its original `occurred_at`.
- Outcome: The sale is never refused for being late.
- Acceptance: An offline override of 15 percent by a cashier (limit 5) posts with a `PRICE_OVERRIDE` exception; a sale dated in a locked October posts on 2 November with `occurred_at` in October retained.
- Test: `test/int/pos/offline-late-sale.int.spec.ts › posts on the first open date and keeps occurred-at`

**FR-POS-015** Open a shift with a float
- Actor: Cashier
- Trigger: `openShift`
- Rule: A register has at most one open shift and a cashier has at most one (partial unique indexes). Opening records the float count by denomination and the cashier.
- Outcome: The shift is `OPEN`.
- Acceptance: Opening a second shift on register T1 returns 422; opening one for the same cashier on T2 returns 422; opening with float 50,000 pesewas posts the float from the safe to the till.
- Test: `test/int/pos/shift-open.int.spec.ts › allows one open shift per register and per cashier`

**FR-POS-016** Cash drops and pay-outs
- Actor: Cashier
- Trigger: `recordCashMovement`
- Rule: A cash drop (till to safe) or pay-out needs a reason and reduces expected cash; both are ledger postings.
- Outcome: Movements appear on the X report.
- Acceptance: A drop of 30,000 reduces expected cash by 30,000; a drop without a reason is refused.
- Test: `test/int/pos/cash-movements.int.spec.ts › reduces expected cash with a reason`

**FR-POS-017** X and Z reports
- Actor: Cashier, Manager
- Trigger: `getShiftXReport`, `getShiftZReport`
- Rule: The X report is a running summary of sales, tenders, drops, voids, returns and expected cash for an open shift. The Z report is produced at close and is immutable. The cashier's X report hides expected cash until their blind count is submitted.
- Outcome: Sales by tender add to total sales exactly.
- Acceptance: A shift with sales 94,000 (50,000 mobile money, 44,000 cash) shows both tenders and a total of 94,000; the Z report cannot be edited after close.
- Test: `test/int/pos/shift-reports.int.spec.ts › totals tenders exactly and freezes the Z report`

**FR-POS-018** Blind close with supervisor sign-off
- Actor: Cashier (declarer), Supervisor
- Trigger: `closeShift`, `approveShiftClose`
- Rule: The cashier declares counted cash without seeing the expected amount; a supervisor signs off the close. Expected cash is shown only after the declaration.
- Outcome: The shift becomes `CLOSING` then `CLOSED`.
- Acceptance: Before declaring, the response contains no expected-cash field; after declaring 63,500 the supervisor sees expected 64,000; the cashier approving their own close is refused.
- Test: `test/int/pos/blind-close.int.spec.ts › hides expected cash until declared`

**FR-POS-019** Over and short posting
- Actor: System
- Trigger: Shift close
- Rule: Over or short equals declared minus expected cash and is posted to account 6900 cash over and short (debit if short, credit if over); the cash returned goes to the safe (1010). Expected cash is float plus cash tendered less change, drops and pay-outs.
- Outcome: The difference is on the Z report and on the daily exception report as `SHIFT_OVER_SHORT`.
- Acceptance: Float 50,000 + cash sales 44,000 - drop 30,000 = expected 64,000; declared 63,500 is short 500: 1010 debited 63,500, 6900 debited 500, 1000 credited 64,000; the item appears on the report.
- Test: `test/unit/pos/over-short.unit.spec.ts › computes declared minus expected and posts to 6900`

**FR-POS-020** Force close
- Actor: Manager
- Trigger: `forceCloseShift`
- Rule: A manager can force-close a shift that was abandoned, with a reason; the shift closes at its last known expected cash, a variance is posted when the cash is later counted, and later syncs for it post on the first open date.
- Outcome: The shift is flagged force-closed on every report.
- Acceptance: Force-closing a shift with 12 unsynced offline sales leaves them postable at sync with the flag; the audit event names the manager and reason.
- Test: `test/int/pos/force-close.int.spec.ts › closes with a reason and flags late syncs`

**FR-POS-021** Thermal receipt printing
- Actor: Cashier
- Trigger: A sale completes
- Rule: A receipt prints through ESC/POS with the business profile, receipt number, items, weights, levy breakdown, tenders, change and cashier. A reprint is the archived document with a reprint marker (FR-BIL-009). An offline receipt prints the provisional reference and QR and says the official number follows.
- Outcome: The receipt can be printed again and always matches the archived document.
- Acceptance: Reprinting twice yields two reprint log rows and identical bytes apart from the marker; the provisional layout contains `P-T1-` and the QR payload equal to the sale id.
- Test: `test/e2e/pos/receipt-printing.e2e.spec.ts › prints archived content with a reprint marker`

**FR-POS-022** SMS and WhatsApp receipt delivery
- Actor: Cashier, Customer
- Trigger: Customer gives a number at the sale
- Rule: A receipt can be sent by SMS and WhatsApp through the notification module using an outbox message created in the sale transaction. Until notifications land in B11 (A-048) the counter prints only.
- Outcome: The message links to the document by signed URL, not an open URL.
- Acceptance: Entering +233244123456 queues exactly one message for the sale even if the sale request is retried; a customer who opted out of the channel gets none.
- Test: `test/int/pos/receipt-delivery.int.spec.ts › queues one message per sale in the outbox`

### 4.8 WHL: Wholesale and business accounts

Default session: B10. Brief bullets: business accounts (001, 002); bulk, standing and recurring orders, backorders (003 to 005); credit limit enforcement, override and automatic hold (006 to 008); statements, ageing and dunning (009 to 011). Bad-debt write-off (012) is the contract's closing step for an unrecoverable balance.

**FR-WHL-001** Business account
- Actor: Sales, Manager
- Trigger: `createBusinessAccount`
- Rule: A business account extends a customer with a credit limit in pesewas, payment terms in days, an assigned price list (set through master data) and an assigned account manager. A customer has at most one account.
- Outcome: The account shows limit, current exposure and available credit.
- Acceptance: Creating an account with limit 500,000, terms 30 days and list "Caterers 2026" returns available credit 500,000; a second account for the same customer is refused.
- Test: `test/int/whl/business-account.int.spec.ts › holds limit terms list and manager`

**FR-WHL-002** Credit terms and due dates
- Actor: System
- Trigger: An invoice is issued to a business account
- Rule: The invoice due date is the invoice date plus the account's terms in days, counted as calendar days in Africa/Accra. Terms of 0 mean due on issue.
- Outcome: Due date is printed on the invoice and used by ageing.
- Acceptance: An invoice dated 14 September on 30-day terms is due 14 October.
- Test: `test/unit/whl/due-date.unit.spec.ts › adds terms in calendar days`

**FR-WHL-003** Bulk order entry
- Actor: Sales
- Trigger: `createOrder` with channel `WHOLESALE`
- Rule: A wholesale order accepts many lines in one request with quantities, grades and weights; each line is priced by the engine from the account's list. A line the engine cannot price is saved as needing a quote and the order waits.
- Outcome: The order shows priced lines, lines needing a quote, and the tax breakdown.
- Acceptance: An order of 20 goats, 10 crates of eggs and 4 packs of beef prices all three lines from the account list; a line for an unlisted product is held as needing a quote and the order stays `PLACED`.
- Test: `test/int/whl/bulk-order.int.spec.ts › prices lines from the account list and holds unpriced lines`

**FR-WHL-004** Standing and recurring orders
- Actor: Sales
- Trigger: `createStandingOrder`, `pauseStandingOrder`, `resumeStandingOrder`, `endStandingOrder`
- Rule: A standing order has lines, a schedule (weekly on named days, or every n days) and a start and end. The scheduler generates one order per occurrence idempotently, keyed by standing order and date, and records each run. A paused order generates nothing.
- Outcome: Each run lists the order created or the reason none was.
- Acceptance: A weekly Tuesday order generates one order on 17 November however often the scheduler runs that day; pausing on 18 November stops the next; a run that fails on credit hold records the reason.
- Test: `test/int/whl/standing-orders.int.spec.ts › generates one order per occurrence`

**FR-WHL-005** Backorder handling
- Actor: Sales, Storekeeper
- Trigger: Fulfilment with insufficient stock
- Rule: A line that cannot be fully supplied is fulfilled in part and the remainder becomes a linked backorder with its own passage through the order state machine; the customer is told. A backorder reserves stock when it arrives.
- Outcome: Fulfilled and backordered quantities are visible per line.
- Acceptance: An order for 20 goats with 12 available fulfils 12 and creates a backorder for 8 linked to the first; receiving 10 more reserves 8 to the backorder.
- Test: `test/int/whl/backorders.int.spec.ts › splits an order into fulfilled and backordered parts`

**FR-WHL-006** Credit limit enforcement
- Actor: System
- Trigger: Confirming a credit order
- Rule: Exposure is the outstanding invoiced balance plus the value of confirmed orders not yet invoiced. An order that would take exposure above the credit limit is not confirmed without an approved override.
- Outcome: Refusal names the limit, exposure and the amount over.
- Acceptance: Limit 500,000, exposure 450,000: an order of 60,000 would reach 510,000 and returns 202 `ApprovalPending` (`CREDIT_OVERRIDE`) and the order stays `PLACED`; an order of 50,000 reaches exactly 500,000 and confirms.
- Test: `test/int/whl/credit-limit.int.spec.ts › blocks an order that would exceed the limit`

**FR-WHL-007** Credit override with approval
- Actor: Sales (maker), Manager or Accountant (checker)
- Trigger: Override requested
- Rule: An override needs approval by a different user, records the amount over, the reason and the approver, is audited, and appears on the credit override report and on the daily exception report as `CREDIT_OVERRIDE`.
- Outcome: After approval the order confirms; the override is listed with who approved it.
- Acceptance: A manager approves the 60,000 order with reason "funeral, paid Friday"; `listCreditOverrides` shows it; the requester approving is refused; the item appears on the report.
- Test: `test/int/whl/credit-override.int.spec.ts › approves audits and reports an override`

**FR-WHL-008** Automatic hold past the overdue threshold
- Actor: System
- Trigger: Daily job
- Rule: An account with any invoice more than 30 days past due (seed, SA-05) is placed on hold; a held account cannot confirm credit orders; cash and prepaid orders still work. A manager releases it with a reason, or it releases when the overdue amount is paid.
- Outcome: The hold, its trigger invoice and its release are audited.
- Acceptance: An invoice due 14 October is 30 days past due on 13 November (no hold) and 31 on 14 November (hold placed); a credit order then returns 422; payment of the invoice releases the hold.
- Test: `test/int/whl/account-hold.int.spec.ts › places a hold the day an invoice passes the threshold`

**FR-WHL-009** Customer statements
- Actor: Accountant, Sales
- Trigger: `createStatement`, `sendStatement`
- Rule: A statement for a period shows opening balance, invoices, credit notes, payments, closing balance and the ageing summary. It is archived and sent by the notification module.
- Outcome: Opening plus charges less credits and payments equals closing, exactly.
- Acceptance: Opening 100,000, invoices 250,000, credit note 20,000 and payment 150,000 give closing 180,000; regenerating the same period gives the same document hash.
- Test: `test/int/whl/statements.int.spec.ts › balances opening to closing exactly`

**FR-WHL-010** Ageing report
- Actor: Accountant, Sales
- Trigger: `getAgeingReport`
- Rule: Ageing is computed as at a date from invoice due dates and payment allocations into Current, 1 to 30, 31 to 60, 61 to 90 and over 90 days past due, by customer, with a total over the whole filter.
- Outcome: The buckets sum to the receivables control account.
- Acceptance: An invoice of 80,000 due 14 October, part paid 30,000, as at 13 November shows 50,000 in 1 to 30; as at 14 December it shows 50,000 in 31 to 60; the bucket total equals the 1200 account.
- Test: `test/int/whl/ageing.int.spec.ts › buckets by days past due and ties to receivables`

**FR-WHL-011** Dunning reminders
- Actor: System
- Trigger: Daily job
- Rule: A dunning policy has levels by days past due (seed 7, 14 and 30) with a template and channel (SMS, email). Each invoice receives each level at most once; an opted-out channel is skipped and the next in preference order is tried.
- Outcome: Notices are listed with level, channel and outcome.
- Acceptance: An invoice 7 days past due receives the level 1 SMS once even if the job runs twice; at 14 days, level 2; a paid invoice gets none.
- Test: `test/int/whl/dunning.int.spec.ts › sends each level once per invoice`

**FR-WHL-012** Bad-debt write-off
- Actor: Accountant (maker), Owner (checker)
- Trigger: `writeOffBadDebt`
- Rule: An unrecoverable open item is written off with a reason after approval by a different user: debit 6940 bad debts, credit 1200 receivables. The customer record keeps the history; the invoice is not edited.
- Outcome: The open item closes with a link to the write-off journal.
- Acceptance: Writing off 50,000 returns 202; on approval 6940 is debited 50,000 and 1200 credited 50,000 with the customer as subledger; the original invoice is unchanged.
- Test: `test/int/whl/bad-debt.int.spec.ts › writes off with approval and a journal`

### 4.9 QUO: Quotations and requests for quote

Default session: B10. Brief bullets: public form and internal creation (001 to 003); builder, validity, terms, delivery estimate (003, 004, 012); margin floor, versioning, signed-link acceptance (005 to 010); conversion preserving links (011); pipeline (013).

**FR-QUO-001** Public request-for-quote form
- Actor: Customer or visitor
- Trigger: `submitQuoteRequest`
- Rule: The storefront form takes the buyer's name, a Ghana phone number, optional email, what they want in free text, quantities, a needed-by date and a delivery area. Submission is rate limited by address and phone (fail closed), content-validated and answered with a reference. Live animals reach the farm only through this route online (A-003).
- Outcome: An RFQ with a reference exists and the buyer gets an acknowledgement.
- Acceptance: A valid submission returns a reference; the 6th submission from one address in an hour is refused with 429; a submission with a script tag in the text is stored inert and displayed escaped.
- Test: `test/int/quo/rfq-public.int.spec.ts › accepts valid requests and rate limits abuse`

**FR-QUO-002** Internal request entry
- Actor: Sales
- Trigger: `createRfq`
- Rule: Staff can enter a request received by phone or WhatsApp with the channel, the contact and the text. A request is linked to an existing customer or creates one.
- Outcome: Requests are listed with source and status (`NEW`, `QUOTED`, `CLOSED`).
- Acceptance: Entering a WhatsApp request from +233244123456 links it to the existing customer with that number.
- Test: `test/int/quo/rfq-internal.int.spec.ts › links to an existing customer by phone`

**FR-QUO-003** Quote builder
- Actor: Sales
- Trigger: `createQuote`
- Rule: A quote has lines of catalogue products (priced by the engine or set manually) and free-text requirement lines for live animals (for example "20 goats, 25 to 30 kg, grade A"), quantities, validity, terms and a delivery estimate. A manual price below the engine floor needs approval (FR-QUO-005).
- Outcome: Totals, tax breakdown and margin over cost are computed by the server.
- Acceptance: A quote of 20 goats at 85,000 is 1,700,000 with margin over cost (cost 71,400 each) of 19.0 percent; a free-text line carries no price until a user prices it.
- Test: `test/unit/quo/quote-totals.unit.spec.ts › computes totals tax and margin on the server`

**FR-QUO-004** Validity, terms and delivery estimate
- Actor: Sales
- Trigger: Quote issue
- Rule: A quote carries a validity period (seed 14 days), the terms (payment, deposit, delivery) and a delivery estimate (date or range and fee from the zone). An expired quote cannot be accepted.
- Outcome: Validity end is shown in business dates.
- Acceptance: A quote issued 13 November is valid to 27 November; an acceptance on 28 November is refused.
- Test: `test/unit/quo/quote-validity.unit.spec.ts › expires at the end of the validity date`

**FR-QUO-005** Margin floor approval
- Actor: Sales (maker), Manager (checker)
- Trigger: `issueQuoteVersion`
- Rule: A version whose margin over cost is below the floor (seed 10 percent) needs approval by a different user before issue; the database refuses issue without it.
- Outcome: Below the floor the call returns 202 `ApprovalPending` (`QUOTE_BELOW_MARGIN`).
- Acceptance: Cost 1,428,000: a quote of 1,560,000 (margin 9.24 percent) returns 202; 1,570,800 (10.00 percent) issues directly; the author approving is refused.
- Test: `test/int/quo/quote-margin-floor.int.spec.ts › needs approval below the floor`

**FR-QUO-006** Versioning with revision history
- Actor: Sales
- Trigger: `reviseQuote`
- Rule: An issued version is immutable; a change is a new version with its own number, retaining every earlier version and what changed. Only one version is current.
- Outcome: The version list shows each version with its author, time and totals.
- Acceptance: Revising version 1 (1,700,000) to version 2 (1,600,000) leaves version 1 unchanged, marks version 2 current and lists both; an `UPDATE` to an issued version is refused by the database.
- Test: `test/int/quo/quote-versions.int.spec.ts › keeps every issued version immutable`

**FR-QUO-007** Issue and send a quote
- Actor: Sales
- Trigger: `issueQuoteVersion`
- Rule: Issuing renders the quote as an archived document, creates a signed acceptance link and queues it to the customer through the outbox.
- Outcome: The customer receives the quote and link by the preferred channel.
- Acceptance: Issuing queues exactly one message with the link; re-issuing the same version does not send a second.
- Test: `test/int/quo/quote-issue.int.spec.ts › archives the document and sends one message`

**FR-QUO-008** Acceptance by signed link
- Actor: Customer
- Trigger: `acceptQuoteByLink`
- Rule: The link carries a random token stored hashed, bound to one version and expiring with the quote. Acceptance records name, time and IP and succeeds once (unique per version); a revised quote invalidates the old link.
- Outcome: The quote becomes `ACCEPTED`; a second use of the link is refused.
- Acceptance: Using the link twice gives 200 then 409; using the version 1 link after version 2 is issued is refused; a token one character wrong returns 404.
- Test: `test/int/quo/quote-acceptance.int.spec.ts › accepts once through a signed expiring link`

**FR-QUO-009** Decline and expiry
- Actor: Customer, system
- Trigger: `declineQuoteByLink`; daily job
- Rule: A customer can decline with a reason. A daily job expires quotes past validity and releases their reservations.
- Outcome: The status is `DECLINED` or `EXPIRED` and reportable.
- Acceptance: A quote valid to 27 November is `EXPIRED` on 28 November and its goat reservations are released.
- Test: `test/int/quo/quote-expiry.int.spec.ts › expires and releases reservations`

**FR-QUO-010** Acceptance recorded on behalf of the customer
- Actor: Sales (maker), Manager (checker if below floor)
- Trigger: `recordQuoteAcceptance`
- Rule: Where the buyer accepts by phone or in person, staff record the acceptance with the channel and evidence (message or note); the record is audited and identical in effect to a link acceptance.
- Outcome: The quote converts as for a link acceptance.
- Acceptance: Recording a phone acceptance requires a note and the actor; it cannot be recorded for an expired quote.
- Test: `test/int/quo/quote-manual-acceptance.int.spec.ts › records acceptance with evidence`

**FR-QUO-011** Conversion to order and invoice with every link preserved
- Actor: Sales
- Trigger: `convertQuote`
- Rule: An accepted quote converts to exactly one sales order (unique), with each line carrying the quoted price as its rule reference; the order, and later the invoice, keep the link to the quote, version and request. A partial delivery bills only what was fulfilled.
- Outcome: The order lines show the quote line as their price rule.
- Acceptance: Converting an accepted quote of 20 goats creates one order at 85,000 each; converting it again returns 409; after delivering 12 goats the invoice is for 12 x 85,000 = 1,020,000 and still references the quote.
- Test: `test/int/quo/quote-conversion.int.spec.ts › creates exactly one order that keeps the links`

**FR-QUO-012** Reserved stock for a quoted animal
- Actor: System
- Trigger: Quote issue with specific stock
- Rule: Stock named on a quote line is reserved for the quote's validity; the reservation is consumed by the converted order and released on decline, cancellation or expiry.
- Outcome: The animal shows as reserved for that quote.
- Acceptance: A quote naming G-0142 reserves it; a counter sale of G-0142 is refused until the quote expires or is cancelled.
- Test: `test/int/quo/quote-reservation.int.spec.ts › reserves named stock for the validity`

**FR-QUO-013** Quote pipeline reporting
- Actor: Manager, Sales
- Trigger: `getQuotePipeline`
- Rule: The pipeline counts quotes issued, accepted, declined and expired and their value by period, with win rate (accepted divided by accepted plus declined plus expired) by salesperson and by product line.
- Outcome: Counts reconcile to the quote list for the same filter.
- Acceptance: Of 10 closed quotes (4 accepted, 3 declined, 3 expired) the win rate is 40.0 percent; the totals equal the number of rows in `listQuotes` for the period.
- Test: `test/int/quo/quote-pipeline.int.spec.ts › computes win rate by salesperson and product line`

### 4.10 SHP: Online store

Default session: B7 (ADR-0026). No backend session in the build prompt names the online store; ADR-0026 assigns the catalogue, cart and checkout reservation to B7, order placement and online payment to B9a, and abandoned-cart messaging to B11, confirmed by the owner on 2026-11-13 (A-040). Each requirement states its own session. Brief bullets: catalogue (001, 002); cart, checkout, zone fee, slot picker (003, 005, 008 to 011); customer accounts (012 to 014); catch-weight (007); reservation with timed release (005, 006); promotions and coupons (004); abandoned-cart messaging (015). Assumption SA-13 (confirmed by the owner on 2026-11-13): delivery zones and fees are master data built in B4 (FR-MDM-010); B7 creates `del.delivery_slot` and slot generation, and its checkout accepts a slot without enforcing capacity; slot capacity, cut-offs and scheduling stay in B11 (ADR-0026).

**FR-SHP-001** Public catalogue listing
- Actor: Visitor
- Trigger: `listCatalogue`, `listShopCategories`
- Rule: The public catalogue lists active products with online mode `LISTED` or `REQUEST_TO_BUY`, by category, with search (name and description), filters (category, price range, availability, species) and cursor pagination. Responses carry the public price where resolved and never carry cost, floor, ceiling, stock quantities or internal ids beyond the slug.
- Outcome: A listing page is anonymous and cacheable.
- Acceptance: A search for "goat" returns only listed goat products; a response schema check finds no field containing `cost`; a `HIDDEN` product never appears.
- Test: `test/contract/shp/shop-catalogue.contract.spec.ts › exposes only public fields`

**FR-SHP-002** Product page and availability
- Actor: Visitor
- Trigger: `getCatalogueProduct`
- Rule: A product page by slug shows description, photography in responsive variants, SEO metadata, price or "Request a quote", and availability as `IN_STOCK`, `LOW`, `OUT` or `ON_REQUEST` derived from available-to-promise without revealing the exact quantity.
- Outcome: The page is server-renderable and carries title, description and canonical metadata.
- Acceptance: Available 3 crates shows `LOW` (threshold 5) and 0 shows `OUT`; the exact count is not in the response.
- Test: `test/contract/shp/shop-product.contract.spec.ts › derives availability without exposing quantity`

**FR-SHP-003** Cart
- Actor: Visitor, Customer
- Trigger: `createCart`, `addCartLine`, `updateCartLine`, `removeCartLine`
- Rule: A cart holds lines with product, quantity (or packs for catch-weight) and a re-resolved price. A product in `REQUEST_TO_BUY` mode cannot be added (422 `REQUEST_TO_BUY_ONLY`); the response points to the quote request. A guest cart is identified by an unguessable id and can be adopted by a customer on login.
- Outcome: The cart returns server-computed line totals, tax and a total.
- Acceptance: Adding 2 crates of eggs at 4,500 gives a total of 9,000 computed by the API; adding goat G-0142 returns 422 `REQUEST_TO_BUY_ONLY`; the client never sums rows.
- Test: `test/int/shp/cart.int.spec.ts › re-resolves prices and refuses request-to-buy products`

**FR-SHP-004** Promotions and coupons in the cart
- Actor: Visitor, Customer
- Trigger: `applyCartCoupon`, `removeCartCoupon`
- Rule: A coupon is validated against its limits, validity, targets and stack group by the pricing engine (FR-MDM-018). Only one coupon applies; an automatic promotion and a coupon stack only where their stack groups differ and neither is exclusive. A bundle offer prices the bundle only when every item is present.
- Outcome: The discount is a separate line adjustment.
- Acceptance: A 10 percent coupon on a 9,000 cart discounts exactly 900; a second coupon is refused; a bundle of 1 crate of eggs plus 1 beef pack at 45,000 applies only when both are in the cart.
- Test: `test/int/shp/cart-promotions.int.spec.ts › applies stacking rules and one coupon`

**FR-SHP-005** Stock reservation at checkout
- Actor: Customer
- Trigger: `startCheckout`
- Rule: Starting checkout reserves every line or does not start (serializable). The reservation lasts 15 minutes (A-045, a setting) and shows the expiry time. A single serialised item can be reserved by one checkout only.
- Outcome: The checkout holds the reservations until placed, abandoned or expired.
- Acceptance: Two customers checking out the last 1 crate: one starts, the other gets 422; a cart of 3 lines with the last line unavailable starts none of the three.
- Test: `test/int/shp/checkout-reservation.int.spec.ts › reserves all lines or none`

**FR-SHP-006** Timed release
- Actor: System
- Trigger: Reservation expiry
- Rule: When a checkout's reservation expires unpaid, the scheduler releases it, marks the checkout `EXPIRED`, publishes `shp.CheckoutExpired` and restores the cart. A payment that arrives after expiry is not lost: it is held and refunded or the order is re-reserved if stock allows.
- Outcome: Stock is available again to others immediately.
- Acceptance: 15 minutes and 1 second after start the reserved crate shows as available and the customer sees the expiry; a late verified payment creates a refund request or a new reservation, never a silent loss.
- Test: `test/int/shp/checkout-expiry.int.spec.ts › releases stock and handles a late payment`

**FR-SHP-007** Catch-weight estimate, tolerance and final-charge rule
- Actor: Customer
- Trigger: `getCheckout` for a catch-weight line
- Rule: Checkout shows the estimated total (packs x nominal pack weight x price per kg), the highest possible total (estimate plus tolerance, seed 10 percent) and the rule: the invoice is raised on the weighed quantity and any difference is refunded or collected. The customer accepts the rule before payment.
- Outcome: The three figures and the rule text are in the checkout response.
- Acceptance: 2 packs of beef at nominal 15.000 kg and 2,800 per kg: estimate 84,000, highest 92,400, with the rule; placing without acceptance returns 422.
- Test: `test/int/shp/checkout-catch-weight.int.spec.ts › shows estimate maximum and rule`

**FR-SHP-008** Delivery zone and fee at checkout
- Actor: Customer
- Trigger: `quoteDelivery`, `updateCheckout`
- Rule: The fee comes from the delivery zone of the chosen address; an address outside every zone offers collection only. The fee is an integer and is a separate line, taxed per its category.
- Outcome: The checkout total includes the fee.
- Acceptance: Zone "Dodowa" fee 1,500: a 9,000 cart totals 10,500 (zero-rated goods; delivery standard-rated is shown with its levies); an address in no zone returns "collection only".
- Test: `test/int/shp/checkout-delivery-fee.int.spec.ts › applies the zone fee or collection only`

**FR-SHP-009** Delivery slot picker
- Actor: Customer
- Trigger: `listDeliverySlotOptions`
- Rule: The customer picks a slot from slots with free capacity before the zone's cut-off. Choosing a slot books one unit of capacity inside the checkout reservation. Capacity and cut-off enforcement arrive with the delivery module in B11; until then B7's checkout accepts and stores a chosen slot without checking capacity (SA-13).
- Outcome: Full or cut-off slots are not offered.
- Acceptance: A slot with capacity 5 and 5 booked is not offered; picking a slot after the cut-off is refused.
- Test: `test/int/shp/checkout-slot.int.spec.ts › books capacity inside the checkout`

**FR-SHP-010** Guest and registered checkout
- Actor: Visitor, Customer
- Trigger: `updateCheckout`
- Rule: A guest provides name, phone and address, and receives an unguessable tracking link; a registered customer uses saved addresses. Both can pay online or choose cash on delivery where the zone allows it. Checkout is rate limited by address, cart and customer.
- Outcome: A guest can track an order without an account.
- Acceptance: A guest order's tracking token returns status, estimate and weights but no internal data; 11 checkouts a minute from one address are refused.
- Test: `test/int/shp/guest-checkout.int.spec.ts › tracks by token without exposing internals`

**FR-SHP-011** Place the order and pay
- Actor: Customer
- Trigger: `placeOrder`
- Rule: Placing re-resolves every price; if any changed it is shown and the customer must confirm before payment. The order is created through the order module (channel `ONLINE`), payment is initiated through the provider port outside the transaction, and the order confirms only when payment clears (FR-PAY-005) or cash on delivery is chosen.
- Outcome: The customer sees the confirmed order and a receipt or invoice.
- Acceptance: A price that rose from 4,500 to 4,600 between cart and place returns 409 with the new price and no charge; a cleared payment confirms the order and converts the reservation.
- Test: `test/int/shp/online-order.int.spec.ts › re-prices before payment and confirms on cleared payment`

**FR-SHP-012** Customer profile and saved addresses
- Actor: Customer
- Trigger: `updateMyProfile`, `createMyAddress`
- Rule: A customer manages their profile and addresses; only their own records are reachable (FR-IAM-010).
- Outcome: Addresses can be archived, never hard deleted.
- Acceptance: Customer A cannot read or edit customer B's address by id.
- Test: `test/int/shp/customer-profile.int.spec.ts › manages only the caller's own data`

**FR-SHP-013** Order history and reorder
- Actor: Customer
- Trigger: `listMyOrders`, `reorderMyOrder`
- Rule: A customer sees their orders in a `CustomerOrder` shape with no cost, floor, ceiling or variance. Reorder copies available lines into a new cart at current prices and reports lines that are unavailable.
- Outcome: The customer can follow each order's status and final weighed total.
- Acceptance: A reorder of an order with one now-unlisted item returns a cart with the others and a list naming the unavailable one; no field named `cost` appears.
- Test: `test/contract/shp/customer-order.contract.spec.ts › omits cost and variance fields`

**FR-SHP-014** Downloadable invoices and receipts
- Actor: Customer
- Trigger: `listMyDocuments`, `downloadMyDocument`
- Rule: A customer lists and downloads their own invoices and receipts through signed, expiring URLs, each issue logged.
- Outcome: A document of another customer is unreachable.
- Acceptance: Downloading receipt R1 returns a URL valid 5 minutes and one access log row; requesting another customer's document returns 403.
- Test: `test/int/shp/customer-documents.int.spec.ts › serves only own documents by signed url`

**FR-SHP-015** Abandoned-cart recovery messaging
- Actor: System
- Trigger: Scheduler finds a cart idle
- Rule: A cart with items held by an identified customer or a guest who gave a contact, idle for 2 hours and not checked out, receives at most one reminder by the preferred channel, through the outbox, unless opted out. The cart is not reserved.
- Outcome: The message links to the cart; each cart is messaged once.
- Acceptance: A cart idle 3 hours gets one message; the scheduler running twice sends one; an opted-out customer gets none; a cart that was converted to an order gets none.
- Test: `test/int/shp/abandoned-cart.int.spec.ts › sends at most one reminder per cart`

### 4.11 ORD: Order management and fulfilment

Default session: B9a. B9a builds the order record, state machine, sale posting and returns; B11 adds pick lists, picking, packing, dispatch, partial fulfilment, substitution and cancellation after confirmation (ADR-0026). Requirements say which. Brief bullets: single order record and state machine (001 to 003); pick list, picking with weight, packing, dispatch (008 to 011); partial fulfilment, substitution, cancellation (012 to 014). The brief's order invariants are 003, 004, 006, 007, 010, 014 and 015.

**FR-ORD-001** One order record for every channel
- Actor: Cashier, Sales, Customer, system
- Trigger: `createOrder`
- Rule: An order has one record shape for channels `POS`, `ONLINE`, `WHOLESALE` and `QUOTE`, with customer (optional for a counter sale), lines, adjustments, status, payment status and the quote it came from. There is no second sale record anywhere.
- Outcome: `GET /orders` filters across channels by status, channel, customer and date.
- Acceptance: A counter sale, an online order, a wholesale order and a converted quote each appear in one list with their channel; the schema has no `pos_sale` table.
- Test: `test/int/ord/order-record.int.spec.ts › holds every channel in one record`

**FR-ORD-002** Order state machine and history
- Actor: System
- Trigger: Any status change
- Rule: Status moves only along the documented machine: `PLACED` to `CONFIRMED`, `COMPLETED` (counter sale) or `CANCELLED`; `CONFIRMED` to `PICKING` or `CANCELLED`; `PICKING` to `AWAITING_CUSTOMER`, `PACKED` or `CANCELLED`; `PACKED` to `READY_FOR_COLLECTION` or `DISPATCHED`; `DISPATCHED` to `DELIVERED` or `DELIVERY_FAILED`; `DELIVERY_FAILED` to `DISPATCHED` or `RETURNED`; `DELIVERED` or `READY_FOR_COLLECTION` to `COMPLETED`; `COMPLETED` to `VOIDED` (same shift, approved); `RETURNED` to `CANCELLED`. Every transition is recorded with actor, time and reason.
- Outcome: An illegal transition returns 422 and changes nothing.
- Acceptance: Moving `PLACED` directly to `DELIVERED` returns 422; `listOrderHistory` for a delivered order shows each transition once with actor and time; a direct SQL update to an unlisted status value is refused by the check constraint.
- Test: `test/unit/ord/order-state-machine.unit.spec.ts › allows only the documented transitions`

**FR-ORD-003** Every line carries its pricing record
- Actor: Cashier, Sales
- Trigger: A line is added
- Rule: A line has a price from the engine, from an accepted quote or from an approved manual price, never none. It stores resolved list, floor, ceiling, rule reference, agreed unit price, variance amount and direction, reason code and approval id. An agreed price outside floor and ceiling, or beyond the user's limit, needs an approval by a different user; the database check requires the approval when the flag is set.
- Outcome: The line shows what the engine said and what was charged.
- Acceptance: A line with no price source is refused; agreed 75,000 on floor 80,000 without an approval id is refused by the database; with an approval it posts.
- Test: `test/int/ord/order-line-pricing.int.spec.ts › requires a price source and an approval outside the band`

**FR-ORD-004** A serialised line names one stock unit
- Actor: Cashier, Sales
- Trigger: A serialised product is added
- Rule: A line for a serialised product names exactly one stock unit and has quantity one, enforced by a check. Selling five goats is five lines.
- Outcome: Each animal sold is traceable to its line.
- Acceptance: A line for "goat" with quantity 2 is refused; selling G-0142 and G-0143 creates two lines each with its tag.
- Test: `test/int/ord/serialised-line.int.spec.ts › names one animal with quantity one`

**FR-ORD-005** Confirmation and reservation
- Actor: System
- Trigger: `confirmOrder`
- Rule: Confirming reserves stock for each line and passes the payment or credit check; it moves `PLACED` to `CONFIRMED`. A confirmation that cannot reserve every line keeps the order `PLACED` and lists the lines.
- Outcome: A confirmed order holds stock until fulfilment, cancellation or void.
- Acceptance: Confirming an order for 3 crates with 2 available keeps it `PLACED` listing the shortfall of 1; confirming after receiving more stock reserves all 3.
- Test: `test/int/ord/order-confirm.int.spec.ts › reserves every line or stays placed`

**FR-ORD-006** One transaction posts a sale
- Actor: System
- Trigger: A counter sale completes, or an online or wholesale order is fulfilled
- Rule: In one serializable transaction the sale posting issues stock through inventory, issues the billing document through billing, records tenders through payments and writes the outbox rows; the ledger journals post from the events in the same transaction. Any failure leaves nothing behind.
- Outcome: An order on any channel posts stock, document, payment and ledger together.
- Acceptance: Injecting a failure after the stock issue and before the payment leaves zero movements, zero document numbers consumed (the number is returned by the rollback) and zero journal rows; the same sale without the failure writes one of each.
- Test: `test/int/ord/sale-posting.int.spec.ts › commits stock document payment and ledger together or none`

**FR-ORD-007** A completed order's lines have a movement or an exception
- Actor: System
- Trigger: An order completes
- Rule: Each line of a completed order has a stock movement or a stock exception, never neither (check at completion). A line whose movement is refused, for example an offline sale, is posted with no movement and a stock exception.
- Outcome: Completion is never blocked by an offline stock conflict, and the conflict is never silent.
- Acceptance: Completing an order with one line lacking both is refused by the check; a synced offline line with the exception posts.
- Test: `test/int/ord/order-completion.int.spec.ts › requires a movement or an exception per line`

**FR-ORD-008** Pick list generation
- Actor: Storekeeper, system
- Trigger: `createFulfilment`
- Rule: A confirmed order produces a pick list per fulfilment naming product, quantity or weight estimate, location and, for animals, the tag. A fulfilment can cover part of an order.
- Outcome: The pick list is ordered by location.
- Acceptance: An order of 2 beef packs and 1 crate of eggs yields a pick list of 3 lines grouped by cold room and store; the order moves to `PICKING`.
- Test: `test/int/ord/pick-list.int.spec.ts › creates a fulfilment from a confirmed order`

**FR-ORD-009** Picking with weight capture
- Actor: Storekeeper
- Trigger: `recordPicks`
- Rule: Each pack or item picked is recorded with its lot, weight to 3 places and source. The final line total is `half_up(price per kg x weighed kg)` on the weighed quantity.
- Outcome: The fulfilment line shows ordered estimate, weighed weight and final total.
- Acceptance: Packs of 15.200 and 15.600 kg at 2,800 per kg give weighed 30.800 kg and a final total of 86,240.
- Test: `test/unit/ord/picked-line-total.unit.spec.ts › computes the total from weighed kilograms`

**FR-ORD-010** Tolerance and re-pricing at pick
- Actor: Storekeeper, Customer
- Trigger: Weighed total differs from the estimate
- Rule: A catch-weight line has an estimate (ordered packs x nominal pack weight x price per kg) and a tolerance (seed 10 percent, per product). Within tolerance the order proceeds. Above it the picker must choose different packs; if none fit the order moves to `AWAITING_CUSTOMER` for the customer's consent to the higher total or a substitution. Below it the picker adds or swaps packs where possible, otherwise the order proceeds at the lower total. Fulfilled quantity never exceeds ordered plus tolerance without recorded consent.
- Outcome: The final total, weights and consent are on the order.
- Acceptance: Estimate 30.000 kg at 2,800 (84,000): weighed 30.800 kg (86,240) proceeds; weighed 34.000 kg exceeds the 33.000 kg limit and cannot be fulfilled without consent; weighed 26.000 kg is below 27.000 and the picker is prompted to add a pack.
- Test: `test/int/ord/catch-weight-pick.int.spec.ts › enforces the tolerance and requires consent above it`

**FR-ORD-011** Pack and dispatch confirmation
- Actor: Storekeeper, Driver
- Trigger: `packFulfilment`, `dispatchFulfilment`, `collectFulfilment`
- Rule: Packing seals the picks; dispatch confirms the vehicle or collection, issues the invoice on weighed quantity, allocates any deposit, and notifies the customer of the final total. A pickup order moves `PACKED` to `READY_FOR_COLLECTION` and completes when collected and paid.
- Outcome: The invoice shows the weighed quantity, never the ordered quantity.
- Acceptance: Dispatching the 30.800 kg order issues an invoice for 86,240, allocates the deposit of 84,000 and leaves 2,240 due on delivery; the customer gets one message with the weights.
- Test: `test/int/ord/dispatch.int.spec.ts › invoices the weighed quantity and settles the deposit`

**FR-ORD-012** Partial fulfilment
- Actor: Storekeeper, Sales
- Trigger: Fulfilment short of the order
- Rule: Fulfilment is tracked on lines. A partly fulfilled order moves forward with the fulfilled lines; the remainder is a linked backorder with its own passage through the machine. A partial fulfilment bills only what was fulfilled.
- Outcome: Fulfilled, outstanding and backordered quantities are visible per line.
- Acceptance: Order of 20, fulfilled 12: invoice for 12, backorder for 8 linked to the order; fulfilling the 8 later completes the backorder only.
- Test: `test/int/ord/partial-fulfilment.int.spec.ts › bills only the fulfilled quantity`

**FR-ORD-013** Substitution with customer consent
- Actor: Storekeeper, Customer
- Trigger: `proposeSubstitution`, `recordCustomerConsent`
- Rule: A substitute product is proposed with its price; the order waits in `AWAITING_CUSTOMER` until the customer accepts or refuses, by their account or by a consent recorded by staff with evidence. Refusal cancels the line or the order.
- Outcome: Consent and its channel are recorded on the order.
- Acceptance: A beef pack replaced by pork needs consent; without it the line is not fulfilled; with refusal the order moves to `CANCELLED` and the refund is requested.
- Test: `test/int/ord/substitution.int.spec.ts › needs recorded customer consent`

**FR-ORD-014** Cancellation with release and refund
- Actor: Customer, Sales, Manager
- Trigger: `cancelOrder`, `cancelFulfilment`
- Rule: Cancelling releases reservations, returns picked stock, and requests a refund of anything paid, all in one transaction. A cancel after dispatch is not allowed; use delivery return.
- Outcome: Stock is available again and the refund is requested.
- Acceptance: Cancelling a `PICKING` order with a 84,000 deposit returns the picked packs, releases the reservation and creates a refund request for 84,000; cancelling a `DISPATCHED` order returns 422.
- Test: `test/int/ord/order-cancel.int.spec.ts › releases stock and requests a refund in one transaction`

**FR-ORD-015** Returns against the original order
- Actor: Cashier, Sales
- Trigger: `createReturn`, `submitReturn`
- Rule: A return references the original order and cannot exceed what was sold less what was already returned (database trigger). A return after completion does not change the order's status; it is a separate return with its own credit note.
- Outcome: Returned quantities accumulate per line.
- Acceptance: Sold 2, returned 1, returning 2 more returns 422 and the trigger refuses a direct insert; the order stays `COMPLETED`.
- Test: `test/int/ord/order-return.int.spec.ts › cannot exceed the quantity sold`

**FR-ORD-016** Payment status beside order status
- Actor: System
- Trigger: A payment, allocation or refund
- Rule: Payment status is derived from payments and allocations as `UNPAID`, `DEPOSIT_HELD`, `PART_PAID`, `PAID`, `PART_REFUNDED` or `REFUNDED` and is never set by hand.
- Outcome: The order shows both statuses.
- Acceptance: An order with 84,000 deposited and 86,240 invoiced shows `PART_PAID` until the 2,240 is allocated, then `PAID`.
- Test: `test/unit/ord/payment-status.unit.spec.ts › derives from allocations`

### 4.12 DEL: Delivery and logistics

Default session: B11. Brief bullets: zones, fees, cut-off, slots and capacity (001 to 003); driver assignment, route list, weak-connection driver view (004 to 006); proof of delivery and cash on delivery (008, 009); driver cash reconciliation and failed delivery (010, 011); customer notifications (012). Zones and fees are master data (FR-MDM-010).

**FR-DEL-001** Delivery slots with capacity
- Actor: Manager
- Trigger: `generateDeliverySlots`, `updateDeliverySlot`
- Rule: Slots are generated per zone and date from a template (for example 08:00 to 10:00 and 14:00 to 16:00) with a capacity. Bookings in a slot never exceed its capacity; the check runs under a row lock so concurrent bookings cannot oversell. B7 creates the slot table and generation so that checkout's foreign key exists; B11 adds the capacity rule (ADR-0026, SA-13).
- Outcome: A full slot is closed.
- Acceptance: A slot with capacity 5 booked by 8 concurrent checkouts accepts exactly 5; reducing capacity below bookings is refused.
- Test: `test/int/del/slot-capacity.int.spec.ts › never exceeds capacity under concurrent booking`

**FR-DEL-002** Zone cut-off times
- Actor: Customer, Manager
- Trigger: Scheduling a delivery
- Rule: A zone's cut-off time decides the earliest slot: an order placed after the cut-off for same-day delivery is offered the next served day. Cut-off is evaluated in Africa/Accra.
- Outcome: The slot options reflect the cut-off.
- Acceptance: With cut-off 14:00, an order at 14:01 on a served day is offered slots from the next day; at 13:59 today's remaining slots.
- Test: `test/unit/del/cut-off.unit.spec.ts › picks the earliest slot after the cut-off`

**FR-DEL-003** Delivery scheduling and rescheduling
- Actor: Customer, Sales, Manager
- Trigger: A delivery is created at dispatch; `rescheduleDelivery`
- Rule: A delivery links an order, an address and a slot. Rescheduling frees the old slot and books the new one in one transaction and notifies the customer.
- Outcome: The delivery shows slot and status.
- Acceptance: Moving a delivery from Tuesday 08:00 to Wednesday 14:00 frees one unit in the first and takes one in the second; if the second is full the move fails and the first stays.
- Test: `test/int/del/delivery-reschedule.int.spec.ts › moves a booking atomically`

**FR-DEL-004** Driver assignment
- Actor: Manager
- Trigger: `assignDelivery`
- Rule: A delivery is assigned to one driver with a vehicle. A driver acts only on deliveries assigned to them (ownership rule). Reassignment is audited.
- Outcome: The driver sees the delivery on their route.
- Acceptance: Driver D2 reading D1's delivery gets 403; reassigning moves it to D2's route and logs the change.
- Test: `test/int/del/delivery-assignment.int.spec.ts › limits a driver to their own deliveries`

**FR-DEL-005** Route list for the day
- Actor: Manager, Driver
- Trigger: `createRoute`, `reorderRouteStops`, `startRoute`, `getMyRoute`
- Rule: A route is an ordered list of stops for one driver and day, ordered by a person (no optimisation, BL-033). Starting a route marks its deliveries dispatched and loads the stock onto the vehicle location; stock in the vehicle remains the farm's.
- Outcome: The driver gets their route with stops, addresses, amounts due and contact numbers.
- Acceptance: A route of 6 stops reordered to put stop 4 first lists them in that order; starting it moves the goods to the vehicle location.
- Test: `test/int/del/route.int.spec.ts › orders stops and loads the vehicle`

**FR-DEL-006** Driver view on a weak connection
- Actor: Driver
- Trigger: The driver's device loses signal
- Rule: The driver view needs one round trip to load the day, works from cached data offline, and queues events (on the way, proof, failure, cash) with client ids for `syncDriverEvents`. Sync is idempotent by client id.
- Outcome: A day's deliveries can be completed with no signal and sync later without duplicates.
- Acceptance: Completing 3 deliveries offline and syncing twice produces 3 proofs and 3 cash collections; the response to the first sync is returned again on the second.
- Test: `test/int/del/driver-sync.int.spec.ts › applies each queued event exactly once`

**FR-DEL-007** On the way
- Actor: Driver
- Trigger: `markOnTheWay`
- Rule: The driver marks a stop on the way; the status and time are recorded and the customer is notified (FR-DEL-012).
- Outcome: The delivery is `ON_THE_WAY`.
- Acceptance: Marking a stop already delivered returns 422.
- Test: `test/int/del/on-the-way.int.spec.ts › records the status once`

**FR-DEL-008** Proof of delivery
- Actor: Driver
- Trigger: `recordProofOfDelivery`
- Rule: A delivery completes only with the recipient's name and a signature or a photograph, with time and geolocation when available, and the amount collected. Missing proof is refused by a check.
- Outcome: The delivery moves to `DELIVERED` and the order to `DELIVERED`.
- Acceptance: A proof with a name only is refused; a name and a photograph is accepted; the proof row is insert-only.
- Test: `test/int/del/proof-of-delivery.int.spec.ts › requires a recipient and a signature or photograph`

**FR-DEL-009** Cash on delivery collection
- Actor: Driver
- Trigger: Proof of delivery on a cash-on-delivery order
- Rule: The amount due is fixed by the server at dispatch from the invoice. The proof records the amount collected against the driver, posted to account 1020 cash held by drivers. A collected amount different from the amount due needs a reason and is flagged.
- Outcome: The driver's cash summary shows collections and balance.
- Acceptance: Amount due 2,240 with collected 2,240 posts 1020 debited 2,240; collected 2,000 requires a reason and flags a 240 variance; the driver cannot change the amount due.
- Test: `test/int/del/cod-collection.int.spec.ts › fixes the amount due and posts to the driver account`

**FR-DEL-010** Driver cash reconciliation
- Actor: Driver (declares), Manager or Accountant (checker)
- Trigger: `createDriverCashReconciliation`, `postDriverCashReconciliation`
- Rule: At end of day the driver declares cash; it is compared with the sum of collections; the variance is posted to 6900 and cash moves from 1020 to the safe. Posting needs a user other than the driver.
- Outcome: A `DRIVER_VARIANCE` appears on the daily exception report for any non-zero variance.
- Acceptance: Collections 146,600 and declared 146,100 give a 500 shortage posted to 6900; the driver posting their own reconciliation is refused.
- Test: `test/int/del/driver-reconciliation.int.spec.ts › posts the variance with a different user`

**FR-DEL-011** Failed delivery workflow
- Actor: Driver, Manager
- Trigger: `recordFailedDelivery`; `returnDeliveryToStock`
- Rule: A failed attempt records a reason code, photo optionally and the time. The order moves `DELIVERY_FAILED` and the manager either reschedules (reattempt) or returns the stock to the returns holding location, with a credit note and refund as applicable. Stock in the vehicle remains the farm's until returned.
- Outcome: Attempts are listed; returned stock is not sellable until inspected.
- Acceptance: After 2 failed attempts the manager returns the goods: movements from the vehicle to the returns hold, order `RETURNED`; the stock appears in the returns location and not in saleable stock.
- Test: `test/int/del/failed-delivery.int.spec.ts › reattempts or returns stock to the hold`

**FR-DEL-012** Delivery notifications
- Actor: System
- Trigger: Dispatch, on the way, delivered
- Rule: The customer is notified at dispatch, on the way and delivered, through the outbox in the same transaction as the status change, once per event and recipient.
- Outcome: A notification cannot exist for a rolled-back change, nor be missing for a committed one.
- Acceptance: Marking dispatched queues one message `ORDER_DISPATCHED`; a retry of the request queues none more; a rolled-back dispatch queues none.
- Test: `test/int/del/delivery-notifications.int.spec.ts › queues one message per event in the same transaction`

### 4.13 BIL: Invoicing, receipts and credit notes

Default session: B8. Brief bullets: gap-free tamper-evident numbering (001 to 003, 011); tax and levy breakdown (004, 005, 012); proforma, invoices, receipts, credit and debit notes, archived immutably (006 to 008); reissue and reprint (009); branded templates (010, with FR-DOC-004). Numbering depends on the platform series mechanism (ADR-0015).

**FR-BIL-001** Gap-free numbering inside the transaction
- Actor: System
- Trigger: A billing document is issued
- Rule: A document number is allocated by `platform.allocate_number` inside the issuing transaction, from a series row taken under lock, producing a gap-free series per document type, year and branch (and register for receipts). A rollback returns the number. The fiscal year is taken from the posting date in Africa/Accra.
- Outcome: Issued numbers are consecutive with no gap.
- Acceptance: 200 concurrent invoice issues of which 25 roll back after allocation leave 175 issued invoices numbered consecutively from 1 with no gap and no duplicate, and `number_allocation` rows equal `next_value - 1`.
- Test: `test/int/bil/numbering-concurrency.int.spec.ts › issues gap-free numbers under concurrent load with rollbacks`

**FR-BIL-002** Number format and series
- Actor: System
- Trigger: Series configuration
- Rule: The format is `<PREFIX>-<YEAR>-<BRANCH>-<SEQUENCE>` (for example `INV-2026-ACC-000123`; receipts add the register: `RCP-2026-ACC-T1-000456`). Prefix and padding are settings; allocation is not. A sale that posts after year end takes a number in the year it is posted.
- Outcome: Series are visible and editable only for prefix and padding.
- Acceptance: The 123rd invoice of 2026 at branch ACC is `INV-2026-ACC-000123`; changing the padding to 8 changes the next number to `INV-2026-ACC-00000124`; a sale posted 2 January 2027 takes a 2027 number.
- Test: `test/unit/bil/number-format.unit.spec.ts › formats prefix year branch register and sequence`

**FR-BIL-003** Tamper evidence of the series
- Actor: System
- Trigger: Nightly job
- Rule: Each document stores the hash of its rendered content; per series the job checks that allocations equal `next_value - 1` and that every allocated number belongs to an existing document. A gap or orphan raises an alert and never repairs.
- Outcome: The health endpoint reports the last numbering check.
- Acceptance: Deleting a document row by hand (as a superuser) makes the next nightly job report one orphan allocation; the job changes nothing.
- Test: `test/int/bil/numbering-audit.int.spec.ts › reports an orphan or gap without repairing`

**FR-BIL-004** Tax and levy breakdown on every document
- Actor: System
- Trigger: A document is issued
- Rule: Each line carries one row per levy (VAT, NHIL, GETFund) with code and name as printed, treatment, rate, base, amount and the scheme version used, as immutable snapshots, including levies at zero. Document tax totals are sums of those rows; line net plus levies equals line gross (deferred check).
- Outcome: The printed document shows the full breakdown and states zero-rated or exempt lines.
- Acceptance: An inclusive 42,560 line prints net 35,467, VAT 5,320, NHIL 887 and GETFund 886 (sum 42,560); a live-animal line prints three zero rows and `ZERO_RATED`; a later change of rates does not alter an issued document.
- Test: `test/int/bil/document-tax-rows.int.spec.ts › snapshots every levy and balances line totals`

**FR-BIL-005** Invoice on weighed quantity
- Actor: System
- Trigger: Dispatch of a catch-weight order
- Rule: A catch-weight line is billed on the weighed quantity from the fulfilment, never the ordered quantity; the unit price and weight source are shown.
- Outcome: The invoice quantity equals the sum of picked weights.
- Acceptance: Ordered 2 packs (estimate 30.000 kg), weighed 30.800 kg at 2,800: the invoice shows 30.800 kg and 86,240; an invoice for the 30.000 kg estimate is refused.
- Test: `test/unit/bil/weighed-billing.unit.spec.ts › bills picked weight not ordered quantity`

**FR-BIL-006** Proforma invoices, invoices and receipts
- Actor: Sales, Cashier, system
- Trigger: `issueProforma`; sale completion
- Rule: A proforma is issued from an order without stock or ledger effect and has its own series. An invoice is issued for credit and delivered sales. A receipt is the billing document for a sale paid at once and posts as an invoice.
- Outcome: The correct kind is issued per sale type.
- Acceptance: A counter sale issues a `RECEIPT`; a wholesale delivery on terms issues an `INVOICE`; issuing a proforma posts no journal.
- Test: `test/int/bil/document-kinds.int.spec.ts › issues the right kind per sale type`

**FR-BIL-007** Credit and debit notes
- Actor: Accountant, Manager (approver above limit)
- Trigger: `issueCreditNote`, `issueDebitNote`
- Rule: A credit note references an issued invoice and cannot exceed its uncredited amount (database trigger); a debit note references an invoice and adds charges. Both carry levy rows and post to the ledger. A credit note above the automatic limit is approved.
- Outcome: The original is unchanged; the note is linked.
- Acceptance: A credit of 30,000 against an invoice of 86,240 leaves 56,240 creditable; a further 60,000 is refused; the original invoice hash is unchanged.
- Test: `test/int/bil/credit-note.int.spec.ts › cannot exceed the uncredited amount`

**FR-BIL-008** Immutable PDF archive
- Actor: System
- Trigger: A document is issued
- Rule: Each issued document is rendered to PDF after commit by the worker, archived with its content hash, and frozen: its content, number and totals never change. The archive is insert-only.
- Outcome: `GET /billing-documents/{id}` returns the archived document reference.
- Acceptance: Updating an issued document row or its archive entry is refused by the database; the archive hash equals the SHA-256 of the stored bytes.
- Test: `test/int/bil/document-archive.int.spec.ts › freezes an issued document`

**FR-BIL-009** Reprint, not reissue
- Actor: Cashier, Manager
- Trigger: `reprintBillingDocument`
- Rule: A reprint returns the same archived bytes with a reprint marker and a log entry (who, when, copy number); it never creates a new document or number.
- Outcome: Reprints are listed per document.
- Acceptance: Reprinting twice gives copy numbers 1 and 2, the same hash for the underlying document and no new number in the series.
- Test: `test/int/bil/reprint.int.spec.ts › returns the same document with a marker and no new number`

**FR-BIL-010** Documents use the active template version
- Actor: System
- Trigger: A document is rendered
- Rule: Rendering uses the template version active at issue; the version is recorded so a reprint uses the same one even after a newer version is activated (FR-DOC-004).
- Outcome: The record names the template version.
- Acceptance: After activating template version 3, a reprint of an invoice issued under version 2 renders with version 2.
- Test: `test/int/bil/document-template-version.int.spec.ts › renders with the version used at issue`

**FR-BIL-011** Official number after an offline sale
- Actor: System
- Trigger: An offline sale syncs
- Rule: The document stores both the provisional reference and the official number allocated at sync; either finds the sale. The official number is available by message or reprint.
- Outcome: A customer holding the provisional receipt can find the official document.
- Acceptance: Searching `P-T1-0007-0012` returns the document `RCP-2026-ACC-T1-000789`; the official number is allocated only at sync.
- Test: `test/int/bil/offline-receipt-number.int.spec.ts › links provisional and official numbers`

**FR-BIL-012** Certified-total fields
- Actor: System
- Trigger: A document is issued
- Rule: Documents carry optional certified-total fields so that a future electronic-invoice service that returns totals differing by a pesewa can be accommodated without reworking the pipeline (A-062, BL-004).
- Outcome: The fields exist and are null unless a certification adapter fills them.
- Acceptance: A document with certified totals different from the line sums by 1 pesewa stores both and prints the certified ones; without an adapter the fields are null.
- Test: `test/int/bil/certified-totals.int.spec.ts › stores optional certified totals beside line sums`

### 4.14 PAY: Payments and reconciliation

Default session: B9a. The payment provider sits behind a port with Paystack as the first adapter (A-047). The brief's payment failure-handling edge cases are written as tests before the happy path (007, 008, 013). Brief bullets: capture by method (001, 002, 011); online payment, webhook verification and replay protection (003 to 006); partial payments, overpayments, allocation, suspense (009, 010); refunds and reversals (012 to 014); daily reconciliation and exception queue (016, 017); store credit (015).

**FR-PAY-001** Capture by method with its own clearing behaviour
- Actor: Cashier, Accountant, system
- Trigger: `recordPayment`
- Rule: Cash clears at once into the till. Mobile money and card are pending until verified (FR-PAY-005). Bank transfer is recorded as pending and clears when matched to a bank statement line. A cheque is recorded as pending in cheques awaiting clearance (1130) until cleared. Store credit clears at once against the customer's balance. Every payment has a unique idempotency key and, for provider payments, a unique provider reference.
- Outcome: A payment's status is `PENDING`, `CLEARED`, `FAILED` or `REVERSED` and the method decides which transitions are possible.
- Acceptance: A cash payment of 44,000 is `CLEARED` immediately and debits 1000; a cheque of 100,000 is `PENDING` and debits 1130 only; reusing an idempotency key with the same body returns the first payment, with a different body returns 409.
- Test: `test/int/pay/payment-capture.int.spec.ts › applies each method's clearing behaviour`

**FR-PAY-002** A cleared payment is never edited
- Actor: System
- Trigger: Any attempt to change a cleared payment
- Rule: A cleared payment is frozen by the database; a correction is a reversal (FR-PAY-014) with a link to the original.
- Outcome: The payment's amount, method and reference cannot change.
- Acceptance: An `UPDATE` of a cleared payment's amount is refused; the contract has no update operation for payments.
- Test: `test/int/pay/payment-freeze.int.spec.ts › refuses edits to a cleared payment`

**FR-PAY-003** Initiate an online payment through the provider port
- Actor: Customer, Cashier
- Trigger: `initiateMobileMoneyCharge`
- Rule: The charge is requested outside any business transaction through the provider port with a timeout, bounded retry with jitter and a circuit breaker; the payment row exists first with a unique provider reference and idempotency key so a retry cannot charge twice. Card payments use the provider's hosted or tokenised flow; no card data transits or is stored by the server.
- Outcome: The customer receives a prompt on their phone; the payment is `PENDING`.
- Acceptance: Initiating twice with the same key creates one payment and one provider call; the request body schema has no card number field; with the provider down the call returns 503 and cash remains available.
- Test: `test/int/pay/mobile-money-initiate.int.spec.ts › creates one provider charge per key`

**FR-PAY-004** Webhook verification
- Actor: Payment provider
- Trigger: `receivePaymentWebhook`
- Rule: A webhook is accepted only with a valid signature over the raw body, a timestamp within 5 minutes of server time (SA-03), an event id not seen before (unique key, replay cache) and an amount confirmed against the provider's API. Anything else is rejected with no state change.
- Outcome: Accepted events are stored once by event id.
- Acceptance: A body with one byte changed (bad signature), an event timestamped 6 minutes ago, a replayed event id and an event whose amount differs from the provider's record are each rejected; the valid event is accepted.
- Test: `test/int/pay/webhook-verification.int.spec.ts › rejects bad signature stale timestamp replay and wrong amount`

**FR-PAY-005** Cleared only from a verified callback or lookup
- Actor: System
- Trigger: A mobile money or card payment
- Rule: A mobile money or card payment becomes `CLEARED` only from a verified provider callback or a provider status lookup; no endpoint accepts a client-supplied cleared status; a bank transfer clears only from a matched statement line. Offline, mobile money is not accepted unless a setting allows a manager-approved unverified tender, which goes to the unmatched queue until verified (A-041).
- Outcome: The unmatched and unverified queue lists anything pending verification.
- Acceptance: `POST /payments` with `status: CLEARED` for mobile money returns 422 `PAYMENT_METHOD_REQUIRES_VERIFICATION`; a forged "confirmation SMS" has no code path that creates a cleared payment.
- Test: `test/int/pay/verified-clearing.int.spec.ts › accepts clearing only from provider verification`

**FR-PAY-006** Webhook rejection log
- Actor: System
- Trigger: A rejected webhook
- Rule: Each rejection is logged with the reason, source address, event id (if parseable) and correlation id, and appears on the daily exception report as `WEBHOOK_REJECTED`, with a rate alert when rejections spike. The response gives no hint of which check failed.
- Outcome: The log is queryable by reason and day.
- Acceptance: Five forged webhooks produce five log rows and five report items with the same response body; the rejection is audited.
- Test: `test/int/pay/webhook-rejection-log.int.spec.ts › logs and reports every rejection`

**FR-PAY-007** Provider times out after the customer was charged
- Actor: System
- Trigger: The provider call times out while the customer's phone is charged
- Rule: The payment stays `PENDING`; a worker looks up the status until it clears or fails; the order is not marked paid on timeout, and the customer is never charged twice because the same reference is reused on retry.
- Outcome: A late success arrives by lookup or webhook and clears the payment once.
- Acceptance: Provider simulator: charge succeeds, response times out; the payment is `PENDING`, the lookup 30 seconds later clears it, exactly one clearing journal exists.
- Test: `test/int/pay/payment-timeout-after-charge.int.spec.ts › clears once by lookup after a timeout`

**FR-PAY-008** Webhook ordering, duplicates and missing orders
- Actor: System
- Trigger: A webhook arrives before the API response, twice, or for an order that no longer exists
- Rule: A webhook before the API response matches the payment by reference and clears it; the later response changes nothing. A second delivery of the same event id is a no-op that returns 200. A webhook for an order that no longer exists is stored, answered 200, held as an unmatched payment and raised as a break; the money is never discarded.
- Outcome: Exactly one effect per event.
- Acceptance: Delivering event E1 twice yields one clearing journal; a webhook for a cancelled order creates a deposit in 2200 and a reconciliation break; the payment appears in `listUnmatchedPayments`.
- Test: `test/int/pay/webhook-edge-cases.int.spec.ts › applies once and holds an orphan payment`

**FR-PAY-009** Partial payments and allocation
- Actor: Cashier, Accountant
- Trigger: `allocatePayment`, `unallocatePayment`
- Rule: A payment may be allocated to one or more documents or open items. Allocations to a payment never exceed its amount and allocations to a document never exceed its outstanding amount (database trigger). A payment can be unallocated with a reason.
- Outcome: The invoice shows paid and outstanding amounts; the open-item list reflects it.
- Acceptance: Payment 100,000 against invoices of 60,000 and 50,000 allocates 60,000 and 40,000, leaves invoice 2 with 10,000 outstanding; allocating 60,001 to invoice 1 is refused.
- Test: `test/int/pay/payment-allocation.int.spec.ts › never exceeds payment or outstanding`

**FR-PAY-010** Overpayments and the suspense account
- Actor: System
- Trigger: A payment exceeds what it is allocated to, or the payer is unknown
- Rule: The unallocated part of a payment from a known customer is held in customer deposits (2200) until allocated or refunded; a receipt whose payer cannot be identified is held in suspense (2290). Neither is revenue.
- Outcome: Unallocated amounts are listed with age.
- Acceptance: A customer pays 120,000 against an invoice of 100,000: 20,000 sits in 2200; a bank transfer from an unknown sender sits in 2290 and appears on the unmatched queue.
- Test: `test/int/pay/overpayment.int.spec.ts › holds the excess in deposits or suspense`

**FR-PAY-011** Cheque and bank-transfer clearing
- Actor: Accountant
- Trigger: `clearCheque`; statement matching
- Rule: A cheque is cleared by the accountant on the bank's confirmation, moving 1130 to the bank, or bounced, which reverses the allocations. A bank transfer clears when matched to a statement line by amount and reference.
- Outcome: Clearing and bounce are audited and posted.
- Acceptance: Clearing a 100,000 cheque credits 1130 and debits 1100; a bounced cheque reverses the invoice allocation and reopens the 100,000 item.
- Test: `test/int/pay/cheque-clearing.int.spec.ts › clears or bounces and posts`

**FR-PAY-012** Refund request and approval
- Actor: Cashier, Sales (maker); Manager or Accountant (checker)
- Trigger: `requestRefund`
- Rule: A refund references its original payment, cannot exceed the unrefunded amount, and above the automatic limit (seed 20,000 pesewas) is approved by a different user. It goes to the original method, or to store credit by the customer's choice.
- Outcome: The refund report lists every refund by user and amount; each appears on the daily report as `REFUND`.
- Acceptance: Refunding 25,000 of a 30,000 payment returns 202; refunding 6,000 afterwards returns 422 (5,000 left); 15,000 under the limit posts without approval and appears on the report.
- Test: `test/int/pay/refund.int.spec.ts › limits to the unrefunded amount and approves above the limit`

**FR-PAY-013** Refund fails after stock was released
- Actor: System
- Trigger: The provider rejects or times out a refund after the stock was released
- Rule: The refund stays `FAILED` or `PENDING` and is retried by the worker with backoff; stock is not re-reserved; after the retry limit it appears in the reconciliation break queue for manual payment, and `markRefundPaid` records the manual payment with a reference.
- Outcome: The customer's refund is never silently dropped.
- Acceptance: Provider simulator rejects the refund 3 times: the refund is `FAILED`, a break exists, stock stays released; `markRefundPaid` with a reference closes it and posts once.
- Test: `test/int/pay/refund-failure.int.spec.ts › retries then queues a break`

**FR-PAY-014** Payment reversal
- Actor: Accountant (maker), Owner or Manager (checker)
- Trigger: `reversePayment`
- Rule: A reversal of a cleared payment needs a reason and approval, posts the exact reverse of the original journal and reopens the allocated items; it links to the original.
- Outcome: The original remains visible with status `REVERSED`.
- Acceptance: Reversing a 50,000 mobile money payment returns 202; on approval the invoice shows 50,000 outstanding again and the journal is the mirror image.
- Test: `test/int/pay/payment-reversal.int.spec.ts › posts the mirror journal with approval`

**FR-PAY-015** Store credit
- Actor: Cashier, Customer
- Trigger: Refund to store credit; tender of store credit
- Rule: A customer's store credit is a ledger of entries (issue and redeem) held in 2210; redemption cannot exceed the balance.
- Outcome: The customer sees their balance.
- Acceptance: Refunding 6,000 to store credit gives a balance of 6,000; redeeming 6,001 is refused; redeeming 6,000 posts 2210 debited 6,000.
- Test: `test/int/pay/store-credit.int.spec.ts › cannot be redeemed beyond the balance`

**FR-PAY-016** Settlement report and bank statement matching
- Actor: Accountant
- Trigger: `importSettlementReport`, `matchSettlementReport`, `importBankStatement`, `matchBankStatement`
- Rule: Each day the provider's settlement report and the bank statement are imported and matched line by line to recorded payments by reference and amount. Provider fees post to 6910. A line that does not match raises a break; nothing is corrected automatically.
- Outcome: Matched lines are linked; unmatched ones are breaks.
- Acceptance: A settlement of 3 payments totalling 150,000 with a fee of 1,500 matches all three and posts 1100 debited 148,500, 6910 debited 1,500, 1120 credited 150,000; an extra line of 2,000 not in the system raises a break.
- Test: `test/int/pay/settlement-matching.int.spec.ts › matches lines and raises a break for the rest`

**FR-PAY-017** Reconciliation break queue
- Actor: Accountant
- Trigger: `listReconciliationBreaks`, `resolveReconciliationBreak`
- Rule: A break has a kind, the records on each side and an age. Resolution needs a kind (match, write-off, refund, investigate) and a note and goes through the normal approval path for any posting; every break appears on the daily report as `RECONCILIATION_BREAK`.
- Outcome: Open breaks block nothing but are visible and aged.
- Acceptance: A 2,000 provider line with no payment is a break; resolving it as "unmatched customer payment" posts to 2290 with approval; the report shows it until resolved.
- Test: `test/int/pay/reconciliation-breaks.int.spec.ts › records and resolves without auto-correction`

### 4.15 FIN: General ledger and accounting

Default session: B8. Payroll is out of scope (BL-030): wages reach the ledger by manual journal or expense invoice. Brief bullets: chart of accounts (001, 002); balanced double-entry journal (003, 004); automated postings (005 to 007); manual journals, periods, lock and close, closed-period block (008 to 010); trial balance, profit and loss, balance sheet, cash flow (011 to 013); fixed assets and depreciation (014, 015). The posting matrix is ADR-0003; the reconciliation jobs are 016.

**FR-FIN-001** Seeded chart of accounts
- Actor: System
- Trigger: Migration
- Rule: The chart is seeded for a Ghanaian agribusiness as in ADR-0003: assets (1000 cash, 1010 safe, 1020 cash held by drivers, 1100 bank, 1110 mobile money, 1120 provider clearing, 1130 cheques, 1200 receivables, 13xx inventory, 1400 recoverable levies, 15xx fixed assets), liabilities (2000 payables, 2010 goods received not invoiced, 2100 output levies, 2200 customer deposits, 2210 store credit, 2290 suspense, 2300 distributions payable, 2400 loans), equity (3000 investor capital, 3100, 3200, 3300 distributions declared, 3900 opening balance equity), income (40xx, 4100, 4200, 4210, 4220) and expenses (50xx, 5100 to 5210, 6xxx, 6900).
- Outcome: The accountant can list accounts with type, normal side, postable flag and subledger kind.
- Acceptance: A fresh database lists every code above with the right type; 4210 is income-type with normal side debit for variances.
- Test: `test/int/fin/chart-of-accounts.int.spec.ts › seeds the accounts of ADR-0003`

**FR-FIN-002** Account management
- Actor: Accountant
- Trigger: `createAccount`, `updateAccount`
- Rule: New accounts carry code, name, type, normal side, postable flag and subledger kind. An account with journal lines cannot be deleted or change type; only postable accounts receive lines.
- Outcome: A header (non-postable) account refuses lines.
- Acceptance: Posting a line to the non-postable header `1300` is refused by the trigger; changing the type of 1200 after it has lines returns 422.
- Test: `test/int/fin/accounts.int.spec.ts › refuses lines to a non-postable account`

**FR-FIN-003** A journal must balance, enforced by the database
- Actor: System
- Trigger: Any journal save
- Rule: A journal entry cannot be saved unless its debits equal its credits. The check is a deferred constraint trigger at commit, so it also holds for direct SQL and for scripts. A balanced entry has at least two lines and positive amounts.
- Outcome: An unbalanced entry fails the whole transaction.
- Acceptance: An entry with debits 10,000 and credits 9,999 fails with error `JOURNAL_UNBALANCED` at commit and leaves no rows; the same entry with credits 10,000 commits.
- Test: `test/int/fin/journal-balance.int.spec.ts › refuses an unbalanced entry at the database`

**FR-FIN-004** Immutable journals and the subledger rule
- Actor: System
- Trigger: Any update, delete or posting to a control account
- Rule: Entries and lines are never updated or deleted; a correction is a reversing entry. A line on an account with a subledger (1200 customer, 2000 supplier, 2100 levy, 3000 and 2300 investor) names a subledger party; a line on any other account does not.
- Outcome: The journal listing has no edit operation.
- Acceptance: An `UPDATE` of a journal line is refused; a 1200 line with no customer is refused; a 4000 line with a customer is refused.
- Test: `test/int/fin/journal-immutability.int.spec.ts › refuses edits and enforces the subledger rule`

**FR-FIN-005** Every posting event has a complete rule set
- Actor: System
- Trigger: Application boot; CI
- Rule: Every domain event flagged as posting to the ledger has a handler and a complete posting rule set; boot fails with the event's name if not. A posting rule change needs approval by a different user with step-up (kind `POSTING_RULE_CHANGE`), and `fin.account_determination` can map a levy or product group to a different account.
- Outcome: A missing rule is found at start-up, never at the first sale.
- Acceptance: Removing the rule for `bil.CreditNoteIssued` fails the boot assertion naming the event; creating a rule change returns 202 and needs a different approver with a step-up.
- Test: `test/int/fin/posting-rules.int.spec.ts › fails boot on an event without a complete rule`

**FR-FIN-006** Sale postings
- Actor: System
- Trigger: A sale is posted
- Rule: The invoice event debits 1200 at agreed gross, debits 4210 where agreed is below resolved, credits 40xx at resolved net, credits 4100 for a delivery fee and 2100 per levy; the stock-issue event debits 50xx and credits 13xx at the issue value; tender events debit the tender account and credit 1200.
- Outcome: One balanced journal per event, all in the sale transaction.
- Acceptance: Goat list 90,000 agreed 85,000 plus 2 crates of eggs at 9,000 (zero-rated): Dr 1200 94,000, Dr 4210 5,000, Cr 4000 90,000, Cr 4020 9,000; cost Dr 5000 71,400, Cr 1310 71,400; tenders Dr 1000 44,000, Dr 1120 50,000, Cr 1200 94,000; the trial balance sums to zero.
- Test: `test/int/fin/sale-journals.int.spec.ts › posts the sale cost and tender journals`

**FR-FIN-007** Stock and processing postings
- Actor: System
- Trigger: Stock and processing events
- Rule: Events post as in ADR-0003: receipts (Dr 13xx, Cr 2010), write-offs (Dr 5100, 5110 or 5120 by reason, Cr 13xx), processing consumption (Dr 1340, Cr 1310), direct cost (Dr 1340, Cr 2020), processing output (Dr 1320 and 1325, Cr 1340), capitalised feed on growing stock (Dr 1310, Cr 1300) and on breeding stock (Dr 5200, Cr 1300).
- Outcome: Inventory accounts equal the sum of cost pools.
- Acceptance: The goat processing order in FR-PRC-007 debits 1340 with 71,400 (from 1310) and 5,000 (from 2020) and credits it 76,400, leaving 1340 at nil, 1320 at 69,568 and 1325 at 6,832 (offal 5,590 plus by-products 1,242).
- Test: `test/int/fin/stock-journals.int.spec.ts › posts processing and write-off events`

**FR-FIN-008** Manual journals with approval
- Actor: Accountant (maker), Owner (checker)
- Trigger: `createManualJournal`, `submitManualJournal`
- Rule: A manual journal has a date, lines and a reason, is approved by a different user before posting, and records both. The opening balance on day one is entered as such a journal against 3900 (A-005).
- Outcome: It posts only after approval.
- Acceptance: A manual journal of 500,000 submitted by the accountant returns 202 and posts nothing until the owner approves; the accountant approving it is refused; after approval one balanced entry exists.
- Test: `test/int/fin/manual-journal.int.spec.ts › posts only after a different user approves`

**FR-FIN-009** Accounting periods, lock and close, closed-period block
- Actor: Accountant, Owner
- Trigger: `lockAccountingPeriod`, `closeAccountingPeriod`
- Rule: The fiscal year is the calendar year with twelve monthly periods, contiguous and non-overlapping (database exclusion, A-028). No entry posts into a period that is not open (trigger). A late event posts on the first open date and keeps its original `occurred_at`.
- Outcome: A closed period refuses any posting.
- Acceptance: Posting a journal dated 15 October after October is closed fails with a period error and posts on 2 November only through the late-event rule; overlapping periods cannot be created.
- Test: `test/int/fin/accounting-periods.int.spec.ts › blocks posting into a closed period`

**FR-FIN-010** Reopening and year close
- Actor: Owner
- Trigger: `reopenAccountingPeriod`
- Rule: A closed period is never reopened; a locked period is reopened only by the Owner with a reason and approval (`PERIOD_REOPEN`). Closing the year moves current year earnings to retained earnings (3200 to 3100).
- Outcome: Reopen and close are audited.
- Acceptance: Reopening a closed period returns 422; reopening a locked one needs the Owner and a reason; year close leaves 3200 at zero and 3100 increased by the year's profit.
- Test: `test/int/fin/period-reopen.int.spec.ts › allows only the owner on a locked period`

**FR-FIN-011** Trial balance for any date range
- Actor: Accountant
- Trigger: `getTrialBalance`
- Rule: A trial balance for any date range lists every account's opening, debits, credits and closing. Total debits equal total credits. Totals are returned by the API for the whole filter.
- Outcome: The trial balance sums to zero on a seeded trading day.
- Acceptance: On the seeded day (sales, purchases, processing and a shift) total debits equal total credits to the pesewa and each account equals the sum of its journal lines.
- Test: `test/int/fin/trial-balance.int.spec.ts › sums to zero over any date range`

**FR-FIN-012** Profit and loss and balance sheet
- Actor: Accountant, Owner
- Trigger: `getProfitAndLoss`, `getBalanceSheet`
- Rule: Both run for any date range or as at date from the ledger. Net profit equals income minus cost of sales minus expenses; the balance sheet satisfies assets = liabilities + equity including current-year earnings.
- Outcome: Figures tie to the trial balance.
- Acceptance: For the seeded day, net profit equals the 4xxx credits less 5xxx and 6xxx debits; assets equal liabilities plus equity exactly.
- Test: `test/int/fin/financial-statements.int.spec.ts › tie to the trial balance`

**FR-FIN-013** Cash flow
- Actor: Accountant
- Trigger: `getCashFlow`
- Rule: The cash flow statement for a date range is derived from movements in the cash and bank accounts classified into operating, investing and financing; its closing cash equals the sum of the cash accounts.
- Outcome: The statement reconciles opening to closing cash.
- Acceptance: Opening 100,000, receipts 300,000 and payments 120,000 close at 280,000 equal to the cash accounts' sum.
- Test: `test/int/fin/cash-flow.int.spec.ts › reconciles opening to closing cash`

**FR-FIN-014** Fixed asset register
- Actor: Accountant
- Trigger: `createFixedAsset`, `disposeFixedAsset`
- Rule: An asset (vehicle, cold room, housing, equipment) has category, cost, in-service date, useful life in months, residual value and location. Disposal records proceeds and posts the gain or loss. Assets are never deleted.
- Outcome: The register shows cost, accumulated depreciation and net book value.
- Acceptance: A cold room costing 1,200,000 with residual 0 and 120 months shows net book value 1,200,000 at purchase and the register lists its schedule.
- Test: `test/int/fin/fixed-assets.int.spec.ts › records cost life and disposal`

**FR-FIN-015** Depreciation schedule and run
- Actor: Accountant (maker), Owner (checker)
- Trigger: `createDepreciationRun`, `postDepreciationRun`
- Rule: Straight-line monthly depreciation is (cost minus residual) divided by useful life, allocated across months by `allocate` so the schedule sums exactly to the depreciable amount, with leftover pesewas in the final months. A run posts Dr 6500, Cr 1590 per asset for one period.
- Outcome: A run is posted once per period.
- Acceptance: Cost 1,200,000, residual 0, life 120 months gives 10,000 per month; cost 1,000,001 over 3 months gives 333,334, 333,334 and 333,333; running the same period twice returns 422.
- Test: `test/unit/fin/depreciation.unit.spec.ts › spreads the depreciable amount exactly`

**FR-FIN-016** Nightly ledger reconciliation
- Actor: System
- Trigger: Nightly job
- Rule: The job asserts the trial balance sums to zero overall and per entry, and that each control account equals its subledger (receivables to open items, inventory to cost pools, provider clearing to unsettled payments). A difference raises an alert with the offending records and `fin.TrialBalanceDriftDetected`, never correcting.
- Outcome: The health endpoint shows the last run and outcome.
- Acceptance: Inserting an unbalanced entry via a disabled trigger (superuser) makes the job report the entry and leave it; the report appears as `RECONCILIATION_BREAK` or `AUDIT_INTEGRITY` as relevant.
- Test: `test/int/fin/ledger-reconciliation.int.spec.ts › reports drift and never corrects`

### 4.16 CAP: Capital, investors and profit sharing

Default session: B12. Distributions are allocated by unit-days with largest-remainder rounding on integer pesewas; the contribution day counts and the withdrawal day does not (ADR-0028, A-009). The brief's "weighted average shareholding" is read as exactly that rule. The five tests named in ADR-0028 are the acceptance tests of 007 to 011. Brief bullets: investor register and documents (001, 002); contributions and withdrawals (003, 004); units with effective dates (005); distribution run (006 to 011); investor statement (013); return metrics (014); loans and grants (015); portal (FR-IAM-013, 013).

**FR-CAP-001** Investor register and agreement
- Actor: Accountant, Owner
- Trigger: `createInvestor`, `updateInvestor`
- Rule: An investor has a number (gap-free, used as the tie key), legal name, contact details, the investment agreement reference and date, and a status. Investor data is confidential.
- Outcome: The register lists investors with their units and status.
- Acceptance: Creating two investors gives numbers 001 and 002; an investor with units or capital transactions is archived, never deleted.
- Test: `test/int/cap/investor-register.int.spec.ts › numbers investors and archives only`

**FR-CAP-002** Payout details and documents
- Actor: Accountant
- Trigger: `updateInvestor`, `addInvestorDocument`
- Rule: Bank or mobile money payout details are restricted data, column-encrypted and decrypted only for the specific permission with each decryption audited. A change needs a different approver. The agreement and identity documents are stored privately and visible to that investor only in their portal.
- Outcome: Details are masked in every response.
- Acceptance: A dump of the investor table shows ciphertext for the account number; another investor cannot download the first investor's agreement.
- Test: `test/int/cap/investor-payout-details.int.spec.ts › encrypts payout details and isolates documents`

**FR-CAP-003** Capital contribution issues units
- Actor: Accountant
- Trigger: `recordCapitalTransaction` of kind contribution
- Rule: A contribution has an amount in pesewas, a value date (the effective date), the receiving account and a unit price (default GHS 1.00 per unit, A-031). It issues units (to 4 decimal places) effective on the value date and posts Dr 1100 or 1110, Cr 3000 with the investor as subledger.
- Outcome: The register shows the new holding from the value date.
- Acceptance: 50,000 pesewas of contribution at GHS 1.00 per unit (100 pesewas) issues 500.0000 units effective on the value date; a contribution dated in a closed period is refused.
- Test: `test/int/cap/capital-contribution.int.spec.ts › issues units at the value date and posts to 3000`

**FR-CAP-004** Capital withdrawal
- Actor: Accountant (maker), Owner (checker)
- Trigger: `recordCapitalTransaction` of kind withdrawal
- Rule: A withdrawal redeems units, cannot exceed the investor's holding at its effective date (database trigger) and needs approval by a different user. It posts Dr 3000, Cr bank.
- Outcome: Units fall from the effective date; the withdrawal day is not a day held.
- Acceptance: Withdrawing 600 units from a holding of 500 is refused by the trigger; withdrawing 100 returns 202 and takes effect on approval; the holding on the effective date shows 400.0000.
- Test: `test/int/cap/capital-withdrawal.int.spec.ts › cannot exceed the holding and needs approval`

**FR-CAP-005** Units with effective dates and percentages
- Actor: System
- Trigger: Any contribution or withdrawal
- Rule: Holdings are units with effective dates, so ownership on any date is units held divided by total units on that date, to 4 decimal places of percent, recomputed after any injection from that date forward.
- Outcome: The register can be read as at any date.
- Acceptance: Ama 1,000 units and Kofi 500 units give 66.6667 and 33.3333 percent; after Esi's 500-unit injection effective 1 March, as at 28 February they are unchanged and as at 1 March they are 50.0000, 25.0000 and 25.0000.
- Test: `test/unit/cap/ownership-percent.unit.spec.ts › recomputes from the effective date`

**FR-CAP-006** Distribution run, retention and distributable profit
- Actor: Accountant
- Trigger: `createDistributionRun`
- Rule: A run covers only locked or closed periods. Net profit is income minus cost of sales minus expenses for the period from the ledger; if zero or negative the run records that and allocates nothing. Retained is `half_up(net profit x retention rate)` (seed 40 percent, snapshotted on the run) and distributable is net profit minus retained.
- Outcome: The run shows net profit, retained, distributable and the day-count convention as text.
- Acceptance: Net profit 1,666,668 pesewas at 40 percent: retained 666,667 and distributable 1,000,001; a run over an open period is refused; a loss period allocates 0 and says so.
- Test: `test/unit/cap/distributable-profit.unit.spec.ts › applies the retention rate with half-up`

**FR-CAP-007** Unit-days with contribution day counted and withdrawal day not
- Actor: System
- Trigger: Run computation
- Rule: Days are Africa/Accra calendar dates and the period is inclusive at both ends. Units issued on E are held on E and every later day; units redeemed on R are held up to the day before R. Unit-days are the sum over the period's days of units held. Actual days are counted (no 30-day month).
- Outcome: Each investor line shows unit-days.
- Acceptance: Period 1 to 30 April 2027: 100 units issued 10 April and redeemed 20 April give 100 x 10 = 1,000 unit-days (10 to 19 April inclusive).
- Test: `test/unit/cap/unit-days.unit.spec.ts › counts the contribution day and not the withdrawal day`

**FR-CAP-008** Largest-remainder allocation
- Actor: System
- Trigger: Run computation
- Rule: The weight passed to `allocate` is unit-days x 10,000 as an integer; each share is floored and leftover pesewas go one at a time to the largest remainders. Allocated amounts sum exactly to distributable (deferred trigger before the run can leave draft).
- Outcome: No pesewa is created or lost.
- Acceptance: 1 January to 31 March 2027, distributable 1,000,001: Ama 90,000 unit-days, Kofi 22,500, Esi 30,250 (total 142,750) allocate 630,474, 157,618 and 211,909; independent half-up rounding (630,473 + 157,618 + 211,909 = 1,000,000) is shown not to be used.
- Test: `test/unit/cap/distribution-allocation.unit.spec.ts › allocates an awkward amount without creating or losing a pesewa`

**FR-CAP-009** Ties and zero weights
- Actor: System
- Trigger: Equal remainders; no unit-days
- Rule: Ties on the leftover pesewa are broken by investor number, lowest first. If total unit-days is zero the run cannot be approved and a typed error is returned, never an equal split.
- Outcome: The outcome is deterministic.
- Acceptance: Three investors with equal unit-days and distributable 100 get 34, 33 and 33 in investor-number order; a run with all weights zero returns an error and writes no allocation rows.
- Test: `test/unit/cap/distribution-allocation.unit.spec.ts › breaks a tie by investor number and refuses zero weights`

**FR-CAP-010** Approval lifecycle with step-up
- Actor: Accountant (maker), Owner (checker)
- Trigger: `submitDistributionRun`, `postDistributionRun`
- Rule: A run moves draft, pending approval, approved by a different user with a step-up TOTP within 5 minutes, posted, paid. A distribution schedule document is archived at submission. Editing a submitted run voids the approval.
- Outcome: The approved schedule is immutable.
- Acceptance: The accountant approving their own run returns 422; an Owner without step-up returns 403; after approval the schedule hash is fixed and a recompute returns 422.
- Test: `test/int/cap/distribution-approval.int.spec.ts › needs a different approver with step-up`

**FR-CAP-011** The posted distribution ties to the ledger
- Actor: System
- Trigger: `postDistributionRun`
- Rule: Posting debits 3300 distributions declared and credits 2300 distributions payable per investor (and 2310 for tax withheld, which defaults to zero, A-030). Withheld tax per investor is `half_up(allocated x rate)` and net payable is allocated minus withheld.
- Outcome: Posted totals equal the run's allocation.
- Acceptance: After posting the 1,000,001 run: 3300 debited 1,000,001 and 2300 credited 630,474, 157,618 and 211,909 on the three investor subledgers; the trial balance sums to zero.
- Test: `test/int/cap/distribution-posting.int.spec.ts › ties the run to the ledger exactly`

**FR-CAP-012** Paying distribution lines
- Actor: Accountant
- Trigger: `recordDistributionPayment`
- Rule: Payments against a distribution line cannot exceed its net payable (trigger); payment debits 2300 and credits bank or mobile money; a line is `PAID` when fully paid.
- Outcome: Outstanding is allocated minus paid.
- Acceptance: Paying 630,474 in two payments of 300,000 and 330,474 closes Ama's line; a payment that would reach 630,475 is refused.
- Test: `test/int/cap/distribution-payment.int.spec.ts › cannot exceed net payable`

**FR-CAP-013** Per-investor statement
- Actor: Accountant, Investor (own)
- Trigger: `getInvestorReturns`; `getMyInvestorStatement`
- Rule: The statement for a period shows contributions, withdrawals, units and current percentage, allocated profit, amounts paid and amounts outstanding. It is served to the investor only for their own record, and the same figures are available to the accountant.
- Outcome: Statement totals tie to the ledger subledger for that investor.
- Acceptance: Ama's statement shows allocated 630,474, paid 630,474, outstanding 0; the 2300 and 3000 subledger balances for Ama equal the statement; Kofi cannot read it.
- Test: `test/int/cap/investor-statement.int.spec.ts › ties to the investor subledger`

**FR-CAP-014** Return metrics
- Actor: Owner, Accountant
- Trigger: `getInvestorReturns`, `getOverallReturns`
- Rule: Return on investment is distributions paid divided by net contributions, as a percentage to 2 places. Payback period is the first date on which cumulative distributions plus withdrawals reach contributions (none until reached). IRR is the XIRR of dated flows (contributions negative; distributions and withdrawals positive) with a closing value of the investor's share of total equity at the as-at date, actual/365, to 4 decimals (SA-14). Figures exist per investor and overall.
- Outcome: Metrics are reproducible from the ledger.
- Acceptance: Contribution 100,000 on 1 January 2027, a distribution of 5,000 paid on 1 January 2028 and a closing value of 110,000 on the same day give ROI 5.00 percent and IRR 0.1500 (115,000 returned on 100,000 over 365 days); no payback is reported while cumulative paid is below 100,000.
- Test: `test/unit/cap/return-metrics.unit.spec.ts › computes roi payback and irr`

**FR-CAP-015** Loans and grants
- Actor: Accountant (maker), Owner (checker)
- Trigger: `createFinancing`, `recordRepayment`
- Rule: Capital that is debt is recorded as a loan with principal, annual rate, start date and a repayment schedule; interest is simple, actual/365, accrued monthly and rounded half-up. A repayment applies to accrued interest first, then principal. A grant is recorded as deferred income (2450) and recognised as income (4910) over its period. Loans post Dr 1100, Cr 2400 on drawing and Dr 6930, Cr 2410 on accrual.
- Outcome: The schedule and balances are visible per financing.
- Acceptance: A loan of 100,000 at 12 percent for 31 days accrues `half_up(100,000 x 0.12 x 31 / 365)` = 1,019; repaying 5,000 clears 1,019 interest then 3,981 principal.
- Test: `test/unit/cap/loan-interest.unit.spec.ts › accrues simple interest and applies repayments to interest first`

### 4.17 CST: Costing and profitability

Default session: B12. CST owns no cost of record: it analyses cost that inventory holds (ADR-0018) and posts overhead through inventory's interface. Brief bullets: cost per animal, pen, batch and processing order (001, 002); margin by product, line, channel, customer, salesperson and branch (003, 004); break-even and contribution margin (005, 006); loss as its own figure (007).

**FR-CST-001** Cost object view by element
- Actor: Manager, Accountant
- Trigger: `getCostObject`
- Rule: For an animal, pen, batch or processing order the view returns accumulated cost split into `PURCHASE`, `FEED`, `VETERINARY`, `LABOUR`, `OVERHEAD` and `PROCESSING` elements, with the movements behind each. The elements sum to the accumulated cost.
- Outcome: The view is readable without an accountant.
- Acceptance: G-0142: purchase 60,000, feed 8,400, veterinary 3,000 sums to 71,400, equal to its cost pool; a processing order shows input cost 71,400 plus direct 5,000.
- Test: `test/int/cst/cost-object.int.spec.ts › splits accumulated cost by element exactly`

**FR-CST-002** Labour and overhead allocation
- Actor: Accountant (maker), Owner or Manager (checker)
- Trigger: `createOverheadAllocation`, `postOverheadAllocation`
- Rule: A period's labour or overhead amount is spread over cost objects by a driver (head-days or kilograms) using `allocate`, and posted as value-only movements through inventory. The allocation sums exactly to the amount allocated (deferred trigger).
- Outcome: Each object's cost rises by its share.
- Acceptance: Allocating 30,001 over pens with head-days 10, 10 and 5 gives 12,001, 12,000 and 6,000; the same run cannot be posted twice for the period.
- Test: `test/int/cst/overhead-allocation.int.spec.ts › spreads the amount exactly and posts once`

**FR-CST-003** Margin by dimension
- Actor: Manager, Owner
- Trigger: `listMargins`
- Rule: Margin is net revenue minus cost of sales, by product, product line, channel, customer, salesperson and branch, for any date range, with margin percent to 2 places and totals over the whole filter. Net revenue excludes levies; negotiated variances (4210) and promotions (4220) are shown, not hidden.
- Outcome: Margins are reproducible by dimension and add up to the total.
- Acceptance: Goat sales of 85,000 (list 90,000) with cost of sales 71,400: revenue net 85,000, margin 13,600, margin percent 16.00; the sum of margins by channel equals the sum by product.
- Test: `test/int/cst/margins.int.spec.ts › compute margin by each dimension and tie out`

**FR-CST-004** Margins tie to the ledger
- Actor: System
- Trigger: Nightly comparison
- Rule: Total net revenue and total cost of sales in the margin projection equal accounts 40xx less 4210 and 4220, and 50xx, for the same dates; a difference raises `rpt.ProjectionDriftDetected` and corrects nothing.
- Outcome: The projection can be rebuilt from events.
- Acceptance: Deleting a projection row in a test makes the nightly check report one drift; the rebuild restores equality.
- Test: `test/int/cst/margin-projection.int.spec.ts › matches the ledger or reports drift`

**FR-CST-005** Break-even per line
- Actor: Manager, Owner
- Trigger: `getBreakEven`
- Rule: For a product line, break-even units are fixed costs divided by contribution margin per unit, rounded up, where contribution margin per unit is average net price minus variable cost per unit; break-even revenue is units times price. Fixed costs are the period's operating expenses assigned to the line.
- Outcome: The result is shown with the inputs.
- Acceptance: Fixed costs 600,000, average net price 85,000, variable cost 71,400: contribution 13,600, break-even 45 heads (44.12 rounded up) and revenue 3,825,000; with contribution zero or negative, a message says there is no break-even.
- Test: `test/unit/cst/break-even.unit.spec.ts › rounds units up and handles non-positive contribution`

**FR-CST-006** Contribution margin view
- Actor: Owner
- Trigger: `getBreakEven`, `listMargins`
- Rule: The owner's view shows per line: units sold, price, variable cost, contribution per unit, total contribution and share of contribution, in plain labels.
- Outcome: It matches FR-CST-003 and FR-CST-005 for the same period.
- Acceptance: Total contribution of the goat line is units x 13,600 and the lines' contributions sum to the total.
- Test: `test/int/cst/contribution-view.int.spec.ts › ties to margins and break-even`

**FR-CST-007** Shrinkage, mortality and wastage as their own figure
- Actor: Owner, Manager
- Trigger: `listLosses`
- Rule: Losses are reported by cause (mortality and cull 5100, shrinkage and adjustments 5110, wastage and expiry 5120), by product line, pen and handler, separate from cost of goods sold, with value and quantity.
- Outcome: A loss never appears inside cost of sales.
- Acceptance: Writing off the doe at 62,500 shows 62,500 under mortality and 0 added to cost of sales 5000; an expired lot of 8,000 shows under wastage.
- Test: `test/int/cst/losses.int.spec.ts › reports shrinkage mortality and wastage apart from cost of sales`

**FR-CST-008** Costing projection rebuild
- Actor: System
- Trigger: Rebuild command
- Rule: Every CST projection can be rebuilt from events and the inventory views and gives the same figures; a nightly comparison with the module of record raises a drift alert.
- Outcome: A rebuild is idempotent.
- Acceptance: Dropping and rebuilding the projection on the seeded data gives identical figures for 12 sample cost objects.
- Test: `test/int/cst/costing-rebuild.int.spec.ts › rebuilds projections to identical figures`

### 4.18 RPT: Reporting and dashboards

Default session: B12. Reports read a separate reporting schema fed by events, under a restricted database role with a statement timeout (ADR-0023); figures of record come from the owning module. The daily exception report is built in B12 (ADR-0026, confirmed by the owner, A-040). Brief bullets: owner dashboard (001); operational reports (002); financial reports plus daily sales (003, and FIN-011 to FIN-013); scheduled reports and exports (004 to 006); separate read model (009, 010). The exception report requirements (007, 008) serve the threat model.

**FR-RPT-001** Owner dashboard
- Actor: Owner
- Trigger: `getOwnerDashboard`
- Rule: The dashboard shows today's sales (completed orders on the current Africa/Accra business date), cash position (cash, safe, bank, mobile money and provider clearing accounts), stock value at cost, outstanding receivables, top movers and alerts, each from the module of record or a verified projection, with an `asOf` time.
- Outcome: One request returns all tiles with totals.
- Acceptance: After the seeded day, today's sales equal the sum of completed order gross totals for that date, cash position equals the sum of accounts 1000 to 1130, stock value equals the sum of cost pools and receivables equal account 1200.
- Test: `test/int/rpt/owner-dashboard.int.spec.ts › ties each tile to its module of record`

**FR-RPT-002** Operational reports
- Actor: Manager
- Trigger: `runReport`
- Rule: Reports exist for stock on hand, ageing stock, expiring lots, mortality rate, feed conversion and delivery performance. Mortality rate is deaths divided by head-days times 1,000; feed conversion is as in FR-LIV-016; delivery performance is deliveries on time divided by deliveries.
- Outcome: Each report returns rows and totals over the whole filter.
- Acceptance: 3 deaths over 1,500 head-days is a rate of 2.000 per 1,000 head-days; 18 of 20 deliveries on time is 90.00 percent.
- Test: `test/int/rpt/operational-reports.int.spec.ts › compute mortality feed and delivery measures`

**FR-RPT-003** Daily sales by channel, payment method and cashier
- Actor: Manager, Accountant
- Trigger: `getDailySales`
- Rule: Daily sales are grouped by channel, by payment method and by cashier for a business date, with totals. Tender totals sum to sales totals net of change.
- Outcome: Groupings each sum to the day's total.
- Acceptance: Day total 94,000 over one counter sale shows channel POS 94,000, tenders mobile money 50,000 and cash 44,000, cashier row 94,000.
- Test: `test/int/rpt/daily-sales.int.spec.ts › groups reconcile to the day's total`

**FR-RPT-004** Report definitions and runs
- Actor: Any permitted user
- Trigger: `runReport`
- Rule: A report is a definition with parameters; each run is recorded in a ledger of runs with the user, parameters, row count and time. A run executes in the worker under the reporting role with a statement timeout.
- Outcome: Runs are listed and re-readable.
- Acceptance: Running the stock report records one run row with the parameters and row count; a query exceeding the timeout is cancelled and the run is `FAILED`, without affecting the counter.
- Test: `test/int/rpt/report-runs.int.spec.ts › records every run and cancels slow queries`

**FR-RPT-005** Export to spreadsheet and PDF
- Actor: Any permitted user
- Trigger: `runReport` with an export format
- Rule: Every report can be exported to spreadsheet and PDF. An export is audited with user, parameters and row count; above 100 rows (SA-02) it needs step-up; the file is delivered by a signed, expiring URL.
- Outcome: The export matches the screen's figures.
- Acceptance: Exporting the customer list of 150 rows without step-up returns 403; with it, the audit event records 150 rows and the export total equals the report total.
- Test: `test/int/rpt/report-export.int.spec.ts › audits rows and demands step-up above 100`

**FR-RPT-006** Scheduled reports by email
- Actor: Owner, Accountant
- Trigger: `createReportSchedule`
- Rule: A schedule runs a report on a recurrence (daily, weekly on a day, monthly) at a time in Africa/Accra and emails it to named recipients through the notification module, once per occurrence, with the export attached as a signed link.
- Outcome: A missed run is not repeated twice.
- Acceptance: A daily 07:00 stock report is delivered once on 14 November even if the scheduler fires twice; a recipient who left is removed without breaking the schedule.
- Test: `test/int/rpt/report-schedule.int.spec.ts › delivers once per occurrence`

**FR-RPT-007** Daily exception report
- Actor: Owner, Accountant
- Trigger: `getDailyExceptionReport`, `listExceptions`
- Rule: For a business date and branch the report lists exception items of 19 kinds: `SALE_VOID`, `PRICE_OVERRIDE`, `REFUND`, `MORTALITY`, `STOCK_ADJUSTMENT`, `STOCK_EXCEPTION`, `UNMATCHED_PAYMENT`, `WEBHOOK_REJECTED`, `DRIVER_VARIANCE`, `SHIFT_OVER_SHORT`, `DEVICE_COUNTER_GAP`, `AUTHORISATION_FAILURE`, `BULK_EXPORT`, `CREDIT_OVERRIDE`, `PAYOUT_DETAIL_CHANGE`, `PERMISSION_CHANGE`, `YIELD_VARIANCE`, `AUDIT_INTEGRITY`, `RECONCILIATION_BREAK`. Each item carries the kind, severity, the numbers of the abuse cases it detects (`abuseCases`), the actor, the amount, the subject document, a summary and details. Every abuse case 1 to 18 appears on at least one kind. The report goes to the owner, not to the approvers.
- Outcome: The items exist whether the control blocked the attempt or not.
- Acceptance: A test raises each of the 19 kinds once and finds an item with the right `abuseCases`; the union of `abuseCases` across kinds is exactly 1 to 18; case 15 appears under both `AUDIT_INTEGRITY` and `RECONCILIATION_BREAK`.
- Test: `test/int/rpt/exception-report.int.spec.ts › covers every abuse case through its kind`

**FR-RPT-008** Detection rates on the daily report
- Actor: Owner
- Trigger: `getDailyExceptionReport`
- Rule: The report carries the rates the threat model requires: void rate by cashier, override value by user per shift, refunds by user, mortality rate by handler against the pen average, adjustments by user with variance trend, driver variances, exports by user with row counts, over and short by cashier, and approval pairs by frequency (the collusion risk R1).
- Outcome: Each table lists user, count, value and comparison.
- Acceptance: A cashier with 4 voids in 40 sales shows a void rate of 10.00 percent; two users approving each other's requests 9 times of 10 show up as a pair with frequency 90.00 percent.
- Test: `test/int/rpt/detection-rates.int.spec.ts › computes rates by user and approval pairs`

**FR-RPT-009** A separate read model
- Actor: System
- Trigger: Events committed
- Rule: The reporting schema is fed from events through a projector and read under a role that can only select from the reporting schema and published views, with a lower connection limit and a statement timeout, so a heavy report cannot slow the counter.
- Outcome: The projector's lag is reported by the health endpoint.
- Acceptance: During a 60-second heavy report the counter sale p95 stays within NFR-002; the reporting role cannot read a transactional table (permission denied).
- Test: `test/int/rpt/read-model.int.spec.ts › isolates heavy reports from the transactional tables`

**FR-RPT-010** Projection drift detection
- Actor: System
- Trigger: Nightly job
- Rule: Key totals (sales, stock value) in the reporting schema are compared with the modules of record; a difference raises `rpt.ProjectionDriftDetected` with both figures and corrects nothing; every projection can be rebuilt from events.
- Outcome: Drift is visible in health and in an alert.
- Acceptance: Altering a projected sales total by 1 pesewa in a test is reported by the next nightly job and left unchanged.
- Test: `test/int/rpt/projection-drift.int.spec.ts › detects and reports a difference`

### 4.19 NTF: Notifications

Default session: B11. Messages are requested through the outbox and sent by the worker; sending is by subscription to events (MODULE_BOUNDARIES). Security codes (login, reset) go through the platform port, not NTF. Brief bullets: templated SMS, WhatsApp, email and in-app messages (001, 002, 008); preferences, opt-out and quiet hours (004 to 006); delivery tracking, retry and log (003, 007).

**FR-NTF-001** Templates
- Actor: Manager
- Trigger: `createNotificationTemplate`, `activateNotificationTemplate`, `previewNotificationTemplate`
- Rule: A template per event and channel has a subject, a body with named merge fields and a locale. A change creates a new version; only an active version is used and messages record the version they used. All text goes through the translation layer; English ships first.
- Outcome: A preview renders with sample data and refuses an unknown merge field.
- Acceptance: A receipt SMS template using `{{total}}` previews as "GHS 940.00"; saving `{{totl}}` returns 422; activating version 2 leaves messages sent under version 1 unchanged.
- Test: `test/int/ntf/notification-templates.int.spec.ts › versions and validates merge fields`

**FR-NTF-002** Triggers
- Actor: Manager
- Trigger: `updateNotificationTrigger`
- Rule: A trigger maps a domain event (receipt, quote issued, order status, dispatch, delivered, payment reminder, low stock) to a template, channel order and recipient rule. Disabling a trigger stops new messages without touching history.
- Outcome: Triggers are listed with their state.
- Acceptance: Disabling the low-stock trigger stops new low-stock messages and leaves 12 sent messages visible.
- Test: `test/int/ntf/notification-triggers.int.spec.ts › enables and disables by event`

**FR-NTF-003** Exactly once per source event and recipient
- Actor: System
- Trigger: An event handled twice
- Rule: Each message has a unique idempotency key made of the source event and recipient, so a replayed event or a retried request sends at most one. The message row and the outbox entry are written in the business transaction.
- Outcome: A sale and its receipt cannot disagree.
- Acceptance: Processing the same `OrderDispatched` event twice produces one message; rolling back the dispatch produces none; a database unique constraint refuses the duplicate row.
- Test: `test/int/ntf/notification-idempotency.int.spec.ts › sends once per event and recipient`

**FR-NTF-004** Channel preferences
- Actor: Customer, staff user
- Trigger: `replaceMyNotificationPreferences`
- Rule: A user or customer sets which channels they accept (SMS, WhatsApp, email, in-app) and an order of preference. A message is sent on the first accepted channel that is available; if it fails, the next is tried.
- Outcome: Preferences apply to every later message.
- Acceptance: A customer preferring WhatsApp then SMS receives the receipt on WhatsApp; if WhatsApp fails 3 times, an SMS is sent once.
- Test: `test/int/ntf/channel-preferences.int.spec.ts › falls back in order`

**FR-NTF-005** Opt-out
- Actor: Customer
- Trigger: Opt-out recorded or keyword received
- Rule: An opted-out recipient receives no marketing or reminder message on that channel; transactional receipts respect the channel preference but are not suppressed by marketing opt-out. Opt-outs are recorded with source and time and are listed.
- Outcome: A message to an opted-out channel is not created.
- Acceptance: A customer who replies STOP to SMS gets no more dunning SMS but still gets a receipt by their accepted channel; the opt-out list shows the source.
- Test: `test/int/ntf/opt-out.int.spec.ts › suppresses reminders and keeps transactional receipts`

**FR-NTF-006** Quiet hours
- Actor: System
- Trigger: A message due between 21:00 and 07:00 Africa/Accra
- Rule: Non-urgent messages are delayed to the end of quiet hours (SA-09), never dropped. Security codes and delivery-day messages are exempt.
- Outcome: The message's scheduled time is shown.
- Acceptance: A reminder due at 22:30 is sent at 07:00 the next day; a security code at 22:30 is sent at once.
- Test: `test/unit/ntf/quiet-hours.unit.spec.ts › delays non-urgent messages to 07:00`

**FR-NTF-007** Delivery tracking, retry and log
- Actor: Manager
- Trigger: `retryNotificationMessage`, `receiveMessagingWebhook`
- Rule: Each message has attempts with outcome and provider receipt; a retry uses bounded retry with backoff and jitter and a circuit breaker per provider; a provider receipt arrives by signed webhook. The log shows what was sent to whom and when with the recipient masked.
- Outcome: A failed message stays visible with its error.
- Acceptance: A message failing twice then succeeding shows 3 attempts and status `DELIVERED`; the log row shows `+23324*****56`; a webhook with a bad signature is rejected.
- Test: `test/int/ntf/notification-delivery.int.spec.ts › retries and records provider receipts`

**FR-NTF-008** In-app notifications
- Actor: Any user
- Trigger: `listMyNotifications`, `markNotificationRead`
- Rule: In-app notifications are stored per recipient with a read state; a user reads only their own.
- Outcome: The unread count is accurate.
- Acceptance: Marking one of 3 unread notifications read leaves 2; user A cannot mark user B's notification.
- Test: `test/int/ntf/in-app-notifications.int.spec.ts › keeps per-recipient read state`

### 4.20 DOC: Documents and media

Default session: B8. The file store, upload pipeline and signed URLs are platform mechanisms needed from B3 and B4 (MODULE_BOUNDARIES); the document archive and templates are built in B8. Brief bullets: immutable archive (001 to 003); photography variants and supplier and investor documents (005, 006); signed expiring URLs with logged access (007); editable branded templates (004).

**FR-DOC-001** Immutable document archive
- Actor: System
- Trigger: A document is issued
- Rule: The archive stores the bytes and SHA-256 hash of every issued quote, invoice, receipt, credit note, debit note, proforma, delivery note, statement and distribution schedule, insert-only. An archived document's bytes never change and a second archive of the same document is refused.
- Outcome: `GET /documents/{id}` returns metadata and the hash; the content is fetched through a signed URL.
- Acceptance: Recomputing the SHA-256 of the stored bytes equals the stored hash; an `UPDATE` or `DELETE` on the archive is refused by trigger; archiving the same document id twice is refused.
- Test: `test/int/doc/document-archive.int.spec.ts › stores bytes with a hash and refuses change`

**FR-DOC-002** Archive covers every document kind
- Actor: System
- Trigger: Each issuing event
- Rule: Every issuing event archives its document: `QUOTE`, `INVOICE`, `RECEIPT`, `CREDIT_NOTE`, `DEBIT_NOTE`, `PROFORMA`, `DELIVERY_NOTE`, `STATEMENT`, `DISTRIBUTION_SCHEDULE` and `REMITTANCE_ADVICE`. A document registry gives each a stable id so no reference to a document in another module can dangle (ADR-0011).
- Outcome: The archive can be filtered by kind, customer, date and related document.
- Acceptance: After the seeded day, every issued quote, invoice, receipt, credit note and delivery note has exactly one archive row; a test finds no issued document without one.
- Test: `test/int/doc/archive-completeness.int.spec.ts › archives every issued document kind`

**FR-DOC-003** Rendering after commit
- Actor: Worker
- Trigger: Outbox entry for a document
- Rule: Documents are rendered to PDF by the worker after the business transaction commits, so object storage trouble cannot fail a sale. A failed render retries with backoff and the document shows `RENDERING` until archived; the content hash is computed from the rendered bytes.
- Outcome: A sale completes even if rendering is down.
- Acceptance: With object storage unavailable, a counter sale completes and its receipt shows `RENDERING`; when storage returns, the PDF is archived once and the receipt can be printed.
- Test: `test/int/doc/document-render.int.spec.ts › completes the sale and renders later`

**FR-DOC-004** Branded templates editable without a deployment
- Actor: Manager, Owner
- Trigger: `createTemplateVersion`, `activateTemplateVersion`, `previewTemplateVersion`
- Rule: Each document type has a template with logo, colours, header and footer and layout. Editing creates a new version; activating it needs the template permission and is audited; issued documents keep the version used. Templates render in a sandbox with no script execution and no remote includes.
- Outcome: A preview renders a sample document before activation.
- Acceptance: Activating version 3 changes the next invoice's footer and no earlier invoice; a template containing `<script>` or a remote image URL is refused at save.
- Test: `test/int/doc/document-templates.int.spec.ts › versions renders in a sandbox and keeps issued documents unchanged`

**FR-DOC-005** Product photography variants and compression
- Actor: Manager
- Trigger: `addProductImage`
- Rule: An uploaded product photo is re-encoded into responsive variants (widths 320, 640 and 1280 pixels, WebP with a JPEG fallback), compressed, with the original kept private; only variants are served publicly, from a separate origin. A listing page's images stay within the page-weight budget.
- Outcome: The catalogue references variants with width and size.
- Acceptance: Uploading a 4 MB JPEG produces three variants, none above 200 KB at 640 pixels; requesting the original from the public origin returns 404.
- Test: `test/int/doc/image-variants.int.spec.ts › produces compressed variants and hides the original`

**FR-DOC-006** Upload pipeline and private supplier and investor documents
- Actor: Staff
- Trigger: `uploadFile`
- Rule: Uploads are capped by size per use (SA-11), type-checked by content sniffing against an allow-list per use, stored under a random key outside the web root with scan status `PENDING`, scanned by the worker and served only when `CLEAN`. Supplier and investor documents are private.
- Outcome: A file that fails scanning is never served.
- Acceptance: An EICAR test file is marked infected and `getFile` refuses it; a 12 MB PDF is refused at the 10 MB cap before the body is fully read.
- Test: `test/int/doc/upload-pipeline.int.spec.ts › sniffs caps scans and serves only clean files`

**FR-DOC-007** Signed expiring URLs with logged access
- Actor: Any authorised user
- Trigger: `createFileSignedUrl`, `downloadArchivedDocument`
- Rule: Every private file and document is served only by a signed URL that expires (seed 5 minutes, SA-04) and each issue is logged with user, file and time; the permission and ownership rule are checked before a URL is issued.
- Outcome: An expired or altered URL is refused by the file origin.
- Acceptance: A URL used after 5 minutes 1 second returns 403; one extra character in the signature returns 403; each of 3 issues produces one access log row.
- Test: `test/int/doc/signed-urls.int.spec.ts › expire and log each issue`

### 4.21 AUD: Audit, compliance and administration

Default session: B3. The audit trail itself is a platform mechanism built in B3 so identity can write to it; administration of settings and numbering is audited. Retention, data-subject requests and the restore procedure are built in B13 (ADR-0026, confirmed by the owner, A-040). Brief bullets: immutable audit log and its fields (001 to 003, 006); read access (005); append-only at the database level (002 to 004); settings, flags, numbering, tax configuration and business profile (007, 008, FR-MDM-012); retention, export, deletion, backup and restore (009 to 012).

**FR-AUD-001** Audit event for every significant action
- Actor: System
- Trigger: Any create, update, delete, login, permission change, price override, approval or export
- Rule: Each such action writes an audit event in the same transaction as the change, recording actor, session, timestamp, IP address, user agent, correlation id, action, entity, branch, and before and after values as canonical JSON. A change cannot commit without its audit row.
- Outcome: The event is retrievable by entity and by actor.
- Acceptance: Changing a product's name writes one event with before "Goat" and after "Goat, Boer"; if the audit insert is forced to fail the product change rolls back; an approval, an override and an export each produce an event.
- Test: `test/int/aud/audit-events.int.spec.ts › commits an audited change and its event together`

**FR-AUD-002** Append-only at the database level
- Actor: System
- Trigger: Any attempt to change an audit row
- Rule: The application role has insert and select on audit events only; triggers reject update, delete and truncate for every role; the sealer role holds insert on the chain and read on events and nothing else.
- Outcome: The application cannot alter history.
- Acceptance: `UPDATE`, `DELETE` and `TRUNCATE` on `platform.audit_event` fail as the application role and as a superuser with triggers enabled; the sealer role cannot update an event.
- Test: `test/int/aud/audit-append-only.int.spec.ts › refuses update delete and truncate`

**FR-AUD-003** Hash chain
- Actor: System
- Trigger: The sealer runs
- Rule: Each event has a content hash set by the database; the sealer writes one chain row per event in transaction order with a gap-free `seq` and `chain_hash = sha256(prev_hash || content_hash || seq)`, the first `prev_hash` being 32 zero bytes. An event left unsealed for more than 5 minutes is alerted.
- Outcome: Each audit event carries the hash of the previous one through its chain row.
- Acceptance: After 100 events the chain has seq 1 to 100 with no gap; altering one event's content makes recomputation disagree at that seq; an event unsealed for 6 minutes raises an alert.
- Test: `test/int/aud/audit-chain.int.spec.ts › links each event to its predecessor by hash`

**FR-AUD-004** Anchor and nightly verification
- Actor: System
- Trigger: Daily; at every shift close; nightly job
- Rule: The sealer signs the chain head with a key held outside the database and writes the anchor to object storage off the server with object lock, and prints it on the daily report. A nightly job recomputes every hash, compares the head with the latest anchor and alerts on mismatch, gap or unsealed event as `AUDIT_INTEGRITY`.
- Outcome: The integrity endpoint reports head, last anchor and verification time.
- Acceptance: Rewriting an event as superuser with triggers disabled and recomputing the chain is detected because the head differs from the signed anchor; the alert is on the report.
- Test: `test/int/aud/audit-verification.int.spec.ts › detects a rewritten chain against the anchor`

**FR-AUD-005** Audit log readable by Owner and Accountant only
- Actor: Owner, Accountant
- Trigger: `listAuditEvents`
- Rule: Only the Owner and Accountant roles hold the permission to read the audit log; Manager and others get 403. Filters are by actor, entity, action, date range and correlation id; reading is itself audited and pagination is cursor based.
- Outcome: An unauthorised read is refused and recorded as an authorisation failure.
- Acceptance: A Manager calling `GET /audit/events` gets 403 and one `AUTHORISATION_FAILURE` item; the Accountant filtering by actor and date gets the matching events.
- Test: `test/int/aud/audit-read-access.int.spec.ts › limits the log to owner and accountant`

**FR-AUD-006** Audit payload hygiene
- Actor: System
- Trigger: An audit event is written
- Rule: Secrets (passwords, tokens, TOTP codes, API keys, card or full account numbers) never appear in a payload. Personal data inside before and after values is encrypted under the data subject's key, so destroying the key makes it unreadable without breaking the chain.
- Outcome: The chain stays valid after a subject's key is destroyed.
- Acceptance: A user creation event contains no password; after destroying a customer's key, the customer's name in historical events cannot be decrypted while `getAuditIntegrity` still verifies.
- Test: `test/int/aud/audit-payload.int.spec.ts › excludes secrets and encrypts personal data per subject`

**FR-AUD-007** Settings and feature flags
- Actor: Owner, Manager
- Trigger: `updateSetting`
- Rule: Typed, validated settings and feature flags (thresholds, retention rate, quiet hours, reservation lifetime, tolerances, offline tender policy) are editable without a deployment, each change audited with before and after, validated against its type and range, and effective at once. A setting that changes money behaviour needs step-up.
- Outcome: A change to an invalid value is refused.
- Acceptance: Setting the checkout hold to -5 minutes returns 422; setting it to 20 takes effect on the next checkout and the audit event shows 15 to 20.
- Test: `test/int/aud/settings.int.spec.ts › validates audits and applies a change without deployment`

**FR-AUD-008** Numbering sequences and business profile
- Actor: Owner, Manager
- Trigger: `updateNumberSeries`, `updateBusinessProfile`
- Rule: Numbering prefix and padding, and the business profile (name, address, tax identification number, phone, logo, receipt footer) are editable and audited; next-value, allocation and gaps are not editable. The tax configuration is administered under FR-MDM-012.
- Outcome: Changes appear on the next document.
- Acceptance: Changing the invoice prefix from `INV` to `INVC` applies to the next number only; an attempt to set `next_value` backwards returns 422.
- Test: `test/int/aud/administration.int.spec.ts › edits prefix and profile but not the sequence value`

**FR-AUD-009** Data retention policy
- Actor: Owner
- Trigger: `updateRetentionPolicy`; scheduled job
- Rule: A retention policy per data category gives a period and an action after it (anonymise or delete). Seed periods are data and are checked against the compliance document before go-live (A-063): financial documents and the ledger are kept for the statutory period and never deleted; notification logs 2 years; carts and expired checkouts 90 days. A scheduled job applies the policy and writes an audit event with counts.
- Outcome: Expired personal data that is not statutory is anonymised or deleted.
- Acceptance: A cart of 91 days idle is deleted by the job and an invoice 91 days old is untouched; the audit event records the count.
- Test: `test/int/aud/retention.int.spec.ts › applies the policy without touching statutory documents`

**FR-AUD-010** Customer data export request
- Actor: Customer, staff (on behalf)
- Trigger: `createMyDataRequest`, `createDataSubjectRequest`, `verifyDataSubjectIdentity`, `processDataSubjectRequest`
- Rule: A data subject can ask for their data. Identity is verified before anything is released; the export is produced within 30 days (a setting) as a file delivered by a signed, expiring URL, and the request, verification and release are audited.
- Outcome: The requester receives only their own data.
- Acceptance: A request without verification is not processed; the export for customer A contains A's profile, addresses, orders and documents and nothing of B; the export is logged with its row counts.
- Test: `test/int/aud/data-export-request.int.spec.ts › verifies identity and releases only the subject's data`

**FR-AUD-011** Customer data deletion request
- Actor: Customer, staff (maker); Manager or Owner (checker)
- Trigger: A deletion request
- Rule: A deletion is approved by a different user (`DATA_DELETION`). Personal data not required by law is erased or anonymised and the subject's encryption key is destroyed, which makes historical audit payloads unreadable; invoices and receipts that must be kept for the statutory period remain and the data subject is told so (A-063). The key destruction is one-way.
- Outcome: The request ends `COMPLETED` or `REJECTED` with reasons.
- Acceptance: After deletion the customer's name is anonymised in orders and unreadable in old audit events, their invoices remain with the retained fields, and restoring the destroyed key is refused by the database.
- Test: `test/int/aud/data-deletion.int.spec.ts › destroys the subject key and keeps statutory documents`

**FR-AUD-012** Backup and tested restore
- Actor: Administrator, Owner
- Trigger: Nightly job; quarterly drill
- Rule: A nightly full backup plus continuous WAL archiving is encrypted on the server before upload with a key separate from the application's, retained 30 days; a restore procedure is documented in `docs/runbooks/` and tested monthly and by a timed quarterly drill that restores into a clean environment, verifies the trial balance and a sample decryption, and records the elapsed time.
- Outcome: The drill log shows date, snapshot, elapsed minutes and result.
- Acceptance: A restore of last night's backup into a clean environment reproduces the trial balance to the pesewa and decrypts a sample investor payout detail; elapsed time is recorded and is under 4 hours (NFR-008).
- Test: `test/smoke/aud/restore-drill.smoke.spec.ts › restores last night's backup and reproduces the trial balance`

**FR-AUD-013** Health reflects audit and reconciliation
- Actor: System
- Trigger: `GET /health`
- Rule: The health endpoint reports audit sealing lag, the last anchor, outbox backlog and age of the oldest undelivered message, dead-lettered deliveries and the time and outcome of each nightly reconciliation job, and the pipeline reads it.
- Outcome: A failing check turns health from `OK` to `DEGRADED` or `FAILING` with the failing item named.
- Acceptance: Stopping the sealer for 10 minutes turns health `DEGRADED` naming audit sealing lag; restarting it returns `OK`.
- Test: `test/int/aud/health.int.spec.ts › reports sealing lag backlog and reconciliation outcomes`

### 4.22 API: Integrations

Default session: B12. The conventions, outbox, idempotency and ports are platform mechanisms built in B2 and B3 and are listed here because they satisfy the brief's API, integrity and failure-handling requirements; webhooks, integrations and the accounting export are built in B12. Brief bullets: versioned REST and generated OpenAPI (001 to 003); outbound webhooks with signing, retry and dead letter (008, 009, 010); API keys with scopes, rotation and limits (007); swappable adapter ports (011, 012). The transactional outbox and the failure-handling rules of "Integrity and reliability" are 005, 006, 013 and 014.

**FR-API-001** Versioned REST API
- Actor: Integration, frontend
- Trigger: Any request
- Rule: The API is served under `/v1`. A breaking change needs a new major version, an entry in `docs/CONTRACT_CHANGELOG.md` and a notice to the frontend track; additive changes are minor.
- Outcome: Clients know which version they call.
- Acceptance: A request to `/v1/products` succeeds; the contract version is 1.0.0; removing a required response field without a version bump fails the contract check.
- Test: `test/contract/api/versioning.contract.spec.ts › fails on an unversioned breaking change`

**FR-API-002** OpenAPI generated from code and enforced in CI
- Actor: CI
- Trigger: Every pull request
- Rule: The OpenAPI document is generated from the code from B2 onward; CI fails if the generated file differs from `contract/openapi.yaml`, and the contract suite checks every response shape against the committed document.
- Outcome: The code and the contract cannot drift.
- Acceptance: Adding a response field in code without regenerating the contract fails the build; a response whose body violates its schema fails the contract test.
- Test: `test/contract/api/openapi-drift.contract.spec.ts › fails when the generated contract differs from the committed one`

**FR-API-003** One set of conventions
- Actor: Integration, frontend
- Trigger: Any request
- Rule: Money is integer pesewas in fields ending `Pesewas` with a `currency` on the object; weights and quantities are decimal strings to 3 places with a `weightSource`; every non-2xx response uses one envelope with `code`, `message`, `correlationId` and `details`; lists use cursor pagination (default 25, maximum 100); a business refusal is 422; a version mismatch or reused idempotency key with a different body is 409; an action needing a second person is 202 with `ApprovalPending` (ADR-0029).
- Outcome: Errors carry a correlation id and no internal detail.
- Acceptance: A 422 response has the envelope and a UUID correlation id equal to the one in the log line; `limit=101` returns 422; no response contains a stack trace, SQL or file path.
- Test: `test/contract/api/conventions.contract.spec.ts › applies the envelope pagination and money naming everywhere`

**FR-API-004** Idempotency keys
- Actor: Integration, frontend, POS device
- Trigger: Any state-changing request
- Rule: Every state-changing request sends `Idempotency-Key`, stored with a request hash under a unique key. A replay with the same key and body returns the first result; the same key with a different body returns 409. External payment references and webhook event ids are unique keys, so a replay collides rather than duplicating.
- Outcome: A retried request has one effect.
- Acceptance: Posting the same `createOrder` twice with one key returns the same order id and creates one row; the same key with a changed quantity returns 409; a create or change request without the header is refused (422); authentication calls, read-only POSTs (price resolution, tax calculation, previews, downloads) and provider webhooks, which carry their own event id, are exempt.
- Test: `test/int/api/idempotency.int.spec.ts › returns the first result for a replay and 409 for a changed body`

**FR-API-005** Transactional outbox
- Actor: System
- Trigger: A business change with a side effect
- Rule: Every side effect (notification, webhook, document rendering, search indexing, payment lookup) is written to the outbox in the same transaction as the business change; a worker dispatches it afterwards; no external call is made inside a business transaction.
- Outcome: A sale and its receipt cannot disagree.
- Acceptance: A sale that rolls back leaves no outbox row; a committed sale has its message row; killing the worker between commit and dispatch loses nothing on restart.
- Test: `test/int/api/outbox.int.spec.ts › writes side effects atomically with the change`

**FR-API-006** Outbox dispatch, retry and dead letter
- Actor: Worker
- Trigger: An outbox entry is pending
- Rule: The dispatcher delivers entries with bounded retry and backoff with jitter; an entry that exceeds the attempt limit is `DEAD` and reported by the health endpoint; subscribers are idempotent through an inbox keyed by event id. Redis loss makes the dispatcher poll the table directly.
- Outcome: A failing subscriber does not block the others.
- Acceptance: A subscriber failing 8 times ends `DEAD`, health reports 1 dead delivery, and the other subscribers of the event still received it once; with Redis stopped the entries still dispatch.
- Test: `test/int/api/outbox-dispatch.int.spec.ts › retries then dead-letters and stays visible`

**FR-API-007** Integrations and API keys
- Actor: Owner, Manager
- Trigger: `createIntegration`, `createApiCredential`, `rotateApiCredential`, `revokeApiCredential`
- Rule: An integration has a name, status and one or more API keys. A key has scoped permissions (it is a principal with role grants), an expiry, a per-key rate limit and is shown once; only its SHA-256 hash is stored. Rotation issues a new key and ends the old one after a grace period; revocation is immediate. Exceeding the limit returns 429.
- Outcome: Keys are listed masked with last-used time.
- Acceptance: A key scoped to `inv.stock.read` calling `POST /orders` gets 403; a key's 61st request in a minute with a limit of 60 gets 429; a rotated old key works until the grace ends then returns 401; the plaintext key is never returned again.
- Test: `test/int/api/api-keys.int.spec.ts › scopes rotates and rate limits per key`

**FR-API-008** Signed outbound webhooks
- Actor: Integration
- Trigger: A subscribed event occurs
- Rule: A webhook endpoint subscribes to event types. Each delivery is an HTTPS POST with an event id, a timestamp and an HMAC-SHA-256 signature over the raw body with the endpoint's secret, so the receiver can verify it and reject replays. The payload carries only what the subscription's scope allows.
- Outcome: A test delivery proves the endpoint.
- Acceptance: A delivery for `order.completed` carries `X-Signature` equal to the HMAC of the body; altering one byte invalidates it; `testWebhookEndpoint` sends a signed ping.
- Test: `test/int/api/webhook-signing.int.spec.ts › signs each delivery with the endpoint secret`

**FR-API-009** Webhook retry and dead letter
- Actor: Worker
- Trigger: A delivery fails
- Rule: A failed delivery is retried 8 times with exponential backoff from 1 minute with jitter, capped at 6 hours (SA-10), then dead-lettered; a dead delivery can be redelivered by a person; every attempt is logged with status code and duration.
- Outcome: No delivery is lost silently.
- Acceptance: An endpoint returning 500 is attempted 8 times at growing intervals, ends `DEAD`, appears in `listWebhookDeliveries`, and `redeliverWebhook` sends it once more.
- Test: `test/int/api/webhook-retry.int.spec.ts › backs off dead-letters and allows redelivery`

**FR-API-010** Webhook endpoint safety
- Actor: Integration
- Trigger: Saving or sending to an endpoint URL
- Rule: A user-supplied endpoint must be HTTPS and is refused at save and at send if it resolves to a private, loopback or link-local address.
- Outcome: The server cannot be pointed at itself or the internal network.
- Acceptance: `http://example.com` and `https://127.0.0.1/hook` and a host resolving to 10.0.0.5 are each refused with 422.
- Test: `test/int/api/webhook-url.int.spec.ts › refuses non-https and internal addresses`

**FR-API-011** Adapter ports
- Actor: System
- Trigger: Any external capability
- Rule: Payments, SMS, WhatsApp, email, object storage and accounting export are ports with a contract suite; an adapter is selected by configuration; domain code imports only the port. The first adapters are Paystack for payments (A-047) and the messaging providers; a second aggregator is not built (BL-011).
- Outcome: Swapping an adapter touches no domain code.
- Acceptance: The same contract suite passes for the real adapter (sandbox) and the in-memory test adapter; a lint rule fails the build if domain code imports an adapter.
- Test: `test/unit/api/adapter-ports.unit.spec.ts › keeps domain code free of adapter imports`

**FR-API-012** Accounting export
- Actor: Accountant
- Trigger: `createAccountingExport`
- Rule: An export produces a file of journals for a date range in a neutral format through the accounting export port, idempotent by range and version, audited with row counts; no named package adapter is built (BL-039).
- Outcome: The file's debit and credit totals are equal and equal the trial balance for the range.
- Acceptance: Exporting 1 to 31 October produces a file whose totals equal the trial balance for the range; running it twice returns the same export.
- Test: `test/int/api/accounting-export.int.spec.ts › exports balanced journals idempotently`

**FR-API-013** External call policy
- Actor: System
- Trigger: Any call that leaves the process
- Rule: Every external call has a timeout, a bounded retry with jitter, a circuit breaker and a defined behaviour when it stays down: payment initiation tells the customer payment is unavailable while cash and cash on delivery continue; messages queue; document rendering queues; rate limiting fails closed on authentication endpoints and open elsewhere. No empty catch block exists; every caught error is handled or rethrown with context.
- Outcome: Behaviour under failure is the specified one.
- Acceptance: With the provider simulator hanging, `initiateMobileMoneyCharge` returns 503 within the timeout and a cash sale still completes; after 5 consecutive failures the breaker opens and calls fail fast.
- Test: `test/int/api/external-call-policy.int.spec.ts › applies timeout retry and breaker with a defined fallback`

**FR-API-014** Health endpoint
- Actor: Uptime monitor, pipeline
- Trigger: `GET /health`
- Rule: The endpoint reports database, Redis, queue depth, outbox backlog, dead-lettered deliveries, WAL archive age and last reconciliation outcomes, requires no authentication and reveals no secret; the deployment pipeline and uptime monitor read it.
- Outcome: A failing dependency changes the status and names the item.
- Acceptance: With Redis stopped the endpoint returns `DEGRADED` naming Redis within 5 seconds; with all healthy it returns `OK` in under 200 ms.
- Test: `test/smoke/api/health.smoke.spec.ts › reports dependency status and names a failing item`

## 5. Security requirements

Each of the 18 abuse cases in section 4 of `docs/security/THREAT_MODEL.md` has one requirement here, numbered the same (SEC-001 is abuse case 1). Each requires both halves of B13's two tests: the primary control blocks the attempt or makes it visible, and the attempt, blocked or not, appears on the daily exception report (`GET /exceptions/daily-report`) under the exception kind named, carrying the case number in `abuseCases`, with the actor, the amount and the subject document. A case that is blocked but leaves no trace on the report is a failing test. SEC-019 to SEC-037 are the required controls of the shared brief's security section. Unless stated, the proving session is B13, which runs the attempts end to end; the control itself is built in the session of the owning module, named in the matrix.

**SEC-001** Cashier voids a sale after taking the cash (abuse case 1)
- Owning module: POS
- Actor: Cashier
- Trigger: The cashier completes a sale, keeps the cash and voids the sale
- Control: A void needs approval by a supervisor who is not the cashier and leaves the order, a credit note and reversing entries as an immutable record (FR-POS-009).
- Detection and exception report: Exception kind `SALE_VOID`: every void appears with cashier, supervisor, amount and receipt; void rate by cashier is in `voidsByCashier`.
- Acceptance: Sale RCP-2026-ACC-T1-000001 for 94,000: the cashier approving their own void is refused (`MAKER_CANNOT_CHECK`); a supervisor's approval reverses the sale; `getDailyExceptionReport` has a `SALE_VOID` item with `abuseCases` [1], actor the cashier, amount 94,000 and subject the receipt; a cashier with 4 voids in 40 sales shows 10.00 percent.
- Tests: `test/e2e/pos/abuse-01-sale-void.e2e.spec.ts › blocks a self-approved void and keeps an immutable record`; `test/e2e/pos/abuse-01-sale-void.e2e.spec.ts › reports the void as SALE_VOID with abuse case 1`

**SEC-002** Storekeeper writes off a healthy animal as dead (abuse case 2)
- Owning module: LIV
- Actor: Storekeeper
- Trigger: A healthy animal is recorded as dead so it can be sold privately
- Control: A mortality at or above the value threshold (seed 50,000 pesewas) needs a photograph and a second approver before stock is written off (FR-LIV-012).
- Detection and exception report: Exception kind `MORTALITY`: every mortality at or above the threshold, and any handler whose mortality rate over 30 days exceeds twice the pen average, appears with handler, animal, value and the rate against the pen average.
- Acceptance: The doe with cost 62,500 reported with no photograph is refused, with a photograph returns 202 and stock stays on hand until a different user approves; the report has a `MORTALITY` item with `abuseCases` [2], the handler, 62,500 and the mortality record; a handler with 6 deaths in a pen averaging 2 appears with the comparison in `mortalityByHandler`.
- Tests: `test/e2e/liv/abuse-02-mortality.e2e.spec.ts › blocks an unapproved high-value write-off`; `test/e2e/liv/abuse-02-mortality.e2e.spec.ts › reports the mortality as MORTALITY with abuse case 2`

**SEC-003** Repeated small price overrides (abuse case 3)
- Owning module: POS
- Actor: Cashier
- Trigger: Many small overrides each within or just beyond the limit
- Control: Override limits per role, per line and per shift; a mandatory reason; every variance posted to account 4210 (FR-POS-004).
- Detection and exception report: Exception kind `PRICE_OVERRIDE`: every override refused or sent for approval, and one item per user per shift once override value reaches 80 percent of the shift limit; `overridesByUser` lists override value per user per shift.
- Acceptance: A cashier with a shift limit of 10,000 making ten overrides of 1,000: the 8th takes the total to 8,000 and raises an item, the 11th is refused; each override debits 4210 by its variance; the item has `abuseCases` [3], the cashier, 8,000 and the shift.
- Tests: `test/e2e/pos/abuse-03-price-override.e2e.spec.ts › refuses overrides beyond the shift limit`; `test/e2e/pos/abuse-03-price-override.e2e.spec.ts › reports override value per user per shift as PRICE_OVERRIDE`

**SEC-004** Forged mobile money confirmation (abuse case 4)
- Owning module: PAY
- Actor: Customer, Cashier
- Trigger: A customer shows a screenshot or SMS as proof of payment
- Control: A payment is recorded only from a verified provider callback or a confirmed account lookup; no screen accepts "paid" on the cashier's word; offline tenders are cash only (FR-PAY-005).
- Detection and exception report: Exception kind `UNMATCHED_PAYMENT`: any attempt to record a mobile money payment as cleared without verification, any tender pending verification for more than 15 minutes, and any unmatched payment, appear with cashier, amount and register.
- Acceptance: A request marking a 50,000 mobile money tender `CLEARED` returns 422 `PAYMENT_METHOD_REQUIRES_VERIFICATION`; the tender left pending for 16 minutes appears; the report item has `abuseCases` [4], the cashier and 50,000; offline the device refuses a mobile money tender.
- Tests: `test/e2e/pay/abuse-04-forged-confirmation.e2e.spec.ts › refuses a cleared status without provider verification`; `test/e2e/pay/abuse-04-forged-confirmation.e2e.spec.ts › reports the unverified tender as UNMATCHED_PAYMENT with abuse case 4`

**SEC-005** Forged webhook marks an order paid (abuse case 5)
- Owning module: PAY
- Actor: External attacker
- Trigger: A forged request to the payment webhook claims a payment cleared
- Control: Signature verification, timestamp window of 5 minutes, replay cache by unique event id, and re-verification of the amount against the provider API (FR-PAY-004).
- Detection and exception report: Exception kind `WEBHOOK_REJECTED`: every rejected webhook with reason category, source address and event id; a rejection-rate alert.
- Acceptance: A webhook with a wrong signature, one with a 6-minute-old timestamp, a replayed event id and one claiming 50,000 where the provider says 5,000 are each rejected and the order stays unpaid; the report has four `WEBHOOK_REJECTED` items with `abuseCases` [5].
- Tests: `test/e2e/pay/abuse-05-forged-webhook.e2e.spec.ts › rejects forged stale replayed and wrong-amount webhooks`; `test/e2e/pay/abuse-05-forged-webhook.e2e.spec.ts › reports each rejection as WEBHOOK_REJECTED with abuse case 5`

**SEC-006** Driver under-declares cash on delivery (abuse case 6)
- Owning module: DEL
- Actor: Driver
- Trigger: A driver collects cash and declares less
- Control: The amount due is fixed by the server at dispatch; proof of delivery records the amount collected; reconciliation at end of day by someone other than the driver (FR-DEL-009, FR-DEL-010).
- Detection and exception report: Exception kind `DRIVER_VARIANCE`: any collected amount different from the amount due and any non-zero reconciliation variance, by driver.
- Acceptance: Amount due 2,240, collected recorded 2,000: a reason is required and a 240 variance is flagged; the day's reconciliation short by 500 is posted to 6900 only by a user other than the driver; the report has `DRIVER_VARIANCE` items with `abuseCases` [6], the driver, 500 and the reconciliation.
- Tests: `test/e2e/del/abuse-06-driver-cash.e2e.spec.ts › refuses a self-posted reconciliation and flags a changed amount`; `test/e2e/del/abuse-06-driver-cash.e2e.spec.ts › reports the variance as DRIVER_VARIANCE with abuse case 6`

**SEC-007** Stock adjustment hides a shortage (abuse case 7)
- Owning module: INV
- Actor: Storekeeper
- Trigger: An adjustment is posted to cover a theft
- Control: Adjustments at or above the threshold need approval; reason codes are a fixed list changed only by migration; posted adjustments are immutable (FR-INV-012).
- Detection and exception report: Exception kind `STOCK_ADJUSTMENT`: every adjustment at or above the threshold and any adjustment within 7 days before a stock take of the same location, with adjustment value by user and the variance trend.
- Acceptance: An adjustment of 50,000 returns 202 and changes no stock until a different user approves; a reason outside the fixed list is refused; editing the posted adjustment is refused; the report item has `abuseCases` [7], the user and 50,000, and `adjustmentsByUser` shows the totals.
- Tests: `test/e2e/inv/abuse-07-stock-adjustment.e2e.spec.ts › blocks an unapproved adjustment and an unlisted reason`; `test/e2e/inv/abuse-07-stock-adjustment.e2e.spec.ts › reports the adjustment as STOCK_ADJUSTMENT with abuse case 7`

**SEC-008** Investor reaches finance data (abuse case 8)
- Owning module: IAM
- Actor: Investor
- Trigger: A read-only investor account calls finance or other investors' endpoints
- Control: Deny-by-default authorisation checked in the domain layer; object-level ownership on every investor permission (FR-IAM-009, FR-IAM-010, FR-IAM-013).
- Detection and exception report: Exception kind `AUTHORISATION_FAILURE`: every authorisation refusal with principal, operation and object; an alert at 5 refusals by one principal in an hour.
- Acceptance: Investor 001 requesting the trial balance, investor 002's statement id, and a customer list gets 403 each; no data leaks in the body; the report has three `AUTHORISATION_FAILURE` items with `abuseCases` [8] naming investor 001.
- Tests: `test/e2e/iam/abuse-08-investor-access.e2e.spec.ts › refuses finance and other investors' data`; `test/e2e/iam/abuse-08-investor-access.e2e.spec.ts › reports each refusal as AUTHORISATION_FAILURE with abuse case 8`

**SEC-009** Insider exports the customer list (abuse case 9)
- Owning module: RPT
- Actor: Manager
- Trigger: An insider exports customers to take them away
- Control: Export is a permission; a bulk export (over 100 rows) needs step-up; every export is audited with row counts (FR-RPT-005, FR-MDM-020).
- Detection and exception report: Exception kind `BULK_EXPORT`: every export above 100 rows, and any user whose exports in a day exceed 1,000 rows, with user, report, row count and time.
- Acceptance: Exporting 150 customers without step-up returns 403; with step-up the audit event records 150 rows; the report has a `BULK_EXPORT` item with `abuseCases` [9], the user and 150 rows; a user exporting 1,200 rows in a day is flagged in `exportsByUser`.
- Tests: `test/e2e/rpt/abuse-09-bulk-export.e2e.spec.ts › refuses a bulk export without step-up`; `test/e2e/rpt/abuse-09-bulk-export.e2e.spec.ts › reports the export as BULK_EXPORT with abuse case 9`

**SEC-010** Offline sale deleted from the device (abuse case 10)
- Owning module: POS
- Actor: Cashier
- Trigger: An offline sale is made and removed from the device before sync
- Control: A gap-free device counter per shift, checked at sync (FR-POS-013).
- Detection and exception report: Exception kind `DEVICE_COUNTER_GAP`: each missing counter value with register, shift and cashier.
- Acceptance: Counters 1 to 10 with 7 omitted: 9 sales sync and one gap exception lists 7; the item has `abuseCases` [10], the cashier, the register and the shift.
- Tests: `test/e2e/pos/abuse-10-counter-gap.e2e.spec.ts › detects a missing device counter at sync`; `test/e2e/pos/abuse-10-counter-gap.e2e.spec.ts › reports the gap as DEVICE_COUNTER_GAP with abuse case 10`

**SEC-011** Animal sold while reserved, held or already sold (abuse case 11)
- Owning module: INV
- Actor: Cashier
- Trigger: The counter sells an animal that cannot be sold
- Control: The stock movement is refused by the database; the sale and money are still recorded; the conflict becomes a stock exception (FR-INV-020, FR-POS-012).
- Detection and exception report: Exception kind `STOCK_EXCEPTION`: every open stock exception with the two conflicting facts.
- Acceptance: An offline sale of G-0142 already sold online posts the order and payment, records no second animal movement and creates an exception; a direct SQL `SALE_ISSUE` for G-0142 is refused; the item has `abuseCases` [11] and the order.
- Tests: `test/e2e/inv/abuse-11-serial-conflict.e2e.spec.ts › refuses a second movement of a sold animal`; `test/e2e/inv/abuse-11-serial-conflict.e2e.spec.ts › reports the conflict as STOCK_EXCEPTION with abuse case 11`

**SEC-012** False return to obtain a refund (abuse case 12)
- Owning module: ORD
- Actor: Cashier, Customer
- Trigger: A return is invented to obtain a refund
- Control: A return references the original order and cannot exceed what was sold; the refund is tied to the original payment and approved above the automatic limit (FR-ORD-015, FR-PAY-012).
- Detection and exception report: Exception kind `REFUND`: every refund at or above the automatic limit and any user whose refund total in a day exceeds 3 times the branch average, in `refundsByUser`.
- Acceptance: Returning 2 more crates after 2 were sold and 1 returned is refused; a refund of 25,000 against a 30,000 payment returns 202; the item has `abuseCases` [12], the user, 25,000 and the original payment.
- Tests: `test/e2e/ord/abuse-12-false-return.e2e.spec.ts › refuses a return beyond what was sold`; `test/e2e/ord/abuse-12-false-return.e2e.spec.ts › reports the refund as REFUND with abuse case 12`

**SEC-013** Supplier payout details changed to divert a payment (abuse case 13)
- Owning module: PUR
- Actor: Accountant
- Trigger: A supplier's mobile money number is changed to the attacker's
- Control: Details are encrypted; a change needs a different approver; payment needs a different approver (FR-PUR-002, FR-PUR-012).
- Detection and exception report: Exception kind `PAYOUT_DETAIL_CHANGE`: every request, approval and rejection of a payout detail change, and any payment prepared within 24 hours after one, with maker and approver.
- Acceptance: A change returns 202 and the old number stays in force; a payment prepared the same day uses the old number and appears flagged; the item has `abuseCases` [13], the maker and the supplier.
- Tests: `test/e2e/pur/abuse-13-payout-change.e2e.spec.ts › holds a payout change until a different user approves`; `test/e2e/pur/abuse-13-payout-change.e2e.spec.ts › reports the change as PAYOUT_DETAIL_CHANGE with abuse case 13`

**SEC-014** Credit sale beyond the limit for a favoured customer (abuse case 14)
- Owning module: WHL
- Actor: Sales
- Trigger: An order is pushed through beyond the credit limit
- Control: The limit is enforced at order confirmation; an override needs approval and is audited (FR-WHL-006, FR-WHL-007).
- Detection and exception report: Exception kind `CREDIT_OVERRIDE`: every override request and approval with the account, amount over, requester and approver, and the account's ageing.
- Acceptance: Limit 500,000, exposure 450,000, order 60,000: returns 202 and the order stays `PLACED`; the requester cannot approve; the approved override appears with `abuseCases` [14] and 10,000 over.
- Tests: `test/e2e/whl/abuse-14-credit-override.e2e.spec.ts › blocks an order over the limit without approval`; `test/e2e/whl/abuse-14-credit-override.e2e.spec.ts › reports the override as CREDIT_OVERRIDE with abuse case 14`

**SEC-015** Audit log or ledger altered in the database (abuse case 15)
- Owning module: AUD
- Actor: Insider with infrastructure access
- Trigger: A superuser rewrites audit rows or journals directly
- Control: Insert-only by trigger and privileges; a hash chain; a signed off-box anchor; nightly reconciliation (FR-AUD-002 to FR-AUD-004, FR-FIN-016).
- Detection and exception report: Exception kinds `AUDIT_INTEGRITY` and `RECONCILIATION_BREAK`: chain verification mismatches, gaps and unsealed events; trial balance and control-account drift.
- Acceptance: As the application role `UPDATE audit_event` fails; as a superuser with triggers disabled, rewriting an event is detected by the nightly verifier against the anchor; altering a journal line is reported as drift; items carry `abuseCases` [15].
- Tests: `test/e2e/aud/abuse-15-ledger-tamper.e2e.spec.ts › refuses direct changes and detects a rewrite`; `test/e2e/aud/abuse-15-ledger-tamper.e2e.spec.ts › reports tampering as AUDIT_INTEGRITY and RECONCILIATION_BREAK with abuse case 15`

**SEC-016** Manager grants a higher role (abuse case 16)
- Owning module: IAM
- Actor: Manager
- Trigger: A manager grants themselves or a friend the Owner role
- Control: Role and grant changes need step-up and are audited; a principal cannot grant themselves a role they do not hold (FR-IAM-022).
- Detection and exception report: Exception kind `PERMISSION_CHANGE`: every grant, revocation and role edit, to the owner.
- Acceptance: The manager granting themselves OWNER gets 403; a grant to a friend without step-up gets 403; an owner-made grant with step-up appears; the items have `abuseCases` [16] and granter, grantee and role.
- Tests: `test/e2e/iam/abuse-16-role-escalation.e2e.spec.ts › refuses a self-grant and a grant without step-up`; `test/e2e/iam/abuse-16-role-escalation.e2e.spec.ts › reports every grant as PERMISSION_CHANGE with abuse case 16`

**SEC-017** Shift closed short (abuse case 17)
- Owning module: POS
- Actor: Cashier
- Trigger: A cashier takes cash and closes the shift short
- Control: Blind close, supervisor sign-off, over and short posted to the ledger (FR-POS-018, FR-POS-019).
- Detection and exception report: Exception kind `SHIFT_OVER_SHORT`: every non-zero difference with cashier, register and amount, and over and short by cashier.
- Acceptance: Expected 64,000, declared 63,500: 6900 debited 500; the cashier cannot see 64,000 before declaring; the supervisor signs off; the item has `abuseCases` [17], the cashier and 500.
- Tests: `test/e2e/pos/abuse-17-shift-short.e2e.spec.ts › hides expected cash and posts the shortage`; `test/e2e/pos/abuse-17-shift-short.e2e.spec.ts › reports the difference as SHIFT_OVER_SHORT with abuse case 17`

**SEC-018** Under-recorded processing yield (abuse case 18)
- Owning module: PRC
- Actor: Farm Hand
- Trigger: Output weight is under-recorded and the difference taken
- Control: Yield is recorded against a standard with a variance flag (FR-PRC-004, FR-PRC-005).
- Detection and exception report: Exception kind `YIELD_VARIANCE`: every order flagged beyond the tolerance with expected, actual, handler and order.
- Acceptance: Expected 14.000 kg, actual 12.600 kg (10 percent short) completes and is flagged; the item has `abuseCases` [18], the handler and the processing order; 13.400 kg is not flagged.
- Tests: `test/e2e/prc/abuse-18-yield.e2e.spec.ts › flags a yield shortfall beyond tolerance`; `test/e2e/prc/abuse-18-yield.e2e.spec.ts › reports the shortfall as YIELD_VARIANCE with abuse case 18`

**SEC-019** Deny by default and object-level checks
- Owning module: IAM
- Actor: Any principal
- Trigger: Any request
- Control: Authorisation is checked in the domain layer as well as the controller, and includes object-level ownership on every record a user can reach; a handler without a declared permission fails the build (FR-IAM-009, FR-IAM-010).
- Detection and exception report: Refusals are recorded as `AUTHORISATION_FAILURE`.
- Acceptance: The handler-walk test fails when a handler has no permission; each module has a test that the wrong role and the wrong owner are refused.
- Tests: `test/unit/iam/authorisation-coverage.unit.spec.ts › fails the build for a handler without a declared permission`; `test/int/iam/ownership.int.spec.ts › refuses every module's records to a non-owner`

**SEC-020** Separation of duties enforced in code
- Owning module: IAM
- Actor: Maker and checker
- Trigger: Stock write-offs, refunds, price list activation, manual journals, supplier payments and investor distributions
- Control: Maker and checker cannot be the same user on any of these; the rule is a database constraint on the approval table and each document needs an approval id to reach its posted status (FR-IAM-012).
- Detection and exception report: Approval pairs by frequency appear in `approvalPairs` to the owner.
- Acceptance: For each of the six kinds a self-approval returns 422 `MAKER_CANNOT_CHECK` and the document stays unposted; a direct SQL approval with equal ids violates the check.
- Tests: `test/int/iam/separation-of-duties.int.spec.ts › refuses a self-approval for each of the six kinds`

**SEC-021** Multi-factor and step-up
- Owning module: IAM
- Actor: Owner, Accountant, Manager
- Trigger: Login; distribution posting; bulk export
- Control: TOTP is required to complete login for Owner, Accountant and Manager; step-up within 5 minutes is required for distributions and any bulk export (FR-IAM-006, FR-IAM-007).
- Detection and exception report: Failed step-ups are audited.
- Acceptance: A manager session without TOTP cannot reach any operation; posting a distribution with a 6-minute-old step-up is refused.
- Tests: `test/int/iam/mfa-and-step-up.int.spec.ts › requires totp at login and fresh step-up for sensitive actions`

**SEC-022** Password storage, lockout and no enumeration
- Owning module: IAM
- Actor: Any user
- Trigger: Login, reset, registration
- Control: Argon2id hashing, a breached-password check at set time, lockout with exponential backoff and no account enumeration in any error message or timing (FR-IAM-002 to FR-IAM-005, FR-IAM-017, FR-IAM-019, FR-IAM-020).
- Detection and exception report: Lockouts are audited.
- Acceptance: Unknown, wrong-password and locked accounts return identical bodies; reset and registration answer identically for known and unknown identifiers.
- Tests: `test/int/iam/no-enumeration.int.spec.ts › returns identical responses for known and unknown accounts`

**SEC-023** Schema validation at the boundary
- Owning module: API
- Actor: Any caller
- Trigger: Any inbound payload
- Control: Every inbound payload is validated by schema at the boundary, unknown fields are rejected, and the parsed type is carried inward so unvalidated data never reaches a service.
- Detection and exception report: Rejections return 422 `VALIDATION_FAILED` with details.
- Acceptance: A body with an extra field `isAdmin` is refused; a string where an integer is required is refused; a test checks every route has a schema.
- Tests: `test/int/api/input-validation.int.spec.ts › rejects unknown fields and wrong types on every route`

**SEC-024** Parameterised queries only and no DDL for the application
- Owning module: API
- Actor: Developer, attacker
- Trigger: Any database access
- Control: All queries are parameterised; dynamic SQL is a review blocker; the application role holds no DDL rights in production and migrations run under a separate role.
- Detection and exception report: A lint and a review gate flag dynamic SQL.
- Acceptance: A request with `' OR 1=1 --` in a search field returns no extra rows; the application role cannot `CREATE TABLE`; the static analysis finds no string-built SQL.
- Tests: `test/int/api/sql-safety.int.spec.ts › resists injection and holds no ddl privilege`

**SEC-025** Browser and transport protections
- Owning module: API
- Actor: Attacker
- Trigger: Any browser request
- Control: Content Security Policy without `unsafe-inline`; HSTS with preload; `SameSite=Strict`, httpOnly, secure `__Host-` cookies; an `X-CSRF-Token` and an allow-listed `Origin` on every cookie-authenticated state change; a CORS allow-list with no wildcard.
- Detection and exception report: Blocked requests are logged.
- Acceptance: A state-changing request without the CSRF token returns 403; one with a foreign `Origin` returns 403; the response headers contain the CSP, HSTS and nosniff values; CORS returns no `*`.
- Tests: `test/int/api/browser-protections.int.spec.ts › enforces csrf cors cookies and security headers`

**SEC-026** Rate limiting
- Owning module: API
- Actor: Attacker
- Trigger: Login, quote submission, checkout, password reset, integrations
- Control: Limits per IP address, per account and per API key, stricter on login, quote submission, checkout and password reset; authentication endpoints fail closed when Redis is down, others fail open. Numeric limits are settings (SA-15).
- Detection and exception report: Limit hits are logged.
- Acceptance: The 11th login attempt from one address in a minute returns 429; with Redis stopped login is refused (fail closed) and the catalogue still serves (fail open).
- Tests: `test/int/api/rate-limits.int.spec.ts › limits per address account and key and fails closed on login`

**SEC-027** File upload safety
- Owning module: DOC
- Actor: Any uploader
- Trigger: An upload
- Control: Type by content sniffing not extension, size capped, scanned, stored outside the web root and served from a separate origin with signed expiring URLs (FR-DOC-006, FR-DOC-007).
- Detection and exception report: Infected files are quarantined and logged.
- Acceptance: A ZIP renamed `.jpg` is refused; an EICAR file is never served; a 12 MB PDF is refused at the cap.
- Tests: `test/int/doc/upload-safety.int.spec.ts › sniffs caps scans and serves only clean files`

**SEC-028** Data classification and handling
- Owning module: AUD
- Actor: All staff
- Trigger: Data handled by the system
- Control: `docs/security/DATA_CLASSIFICATION.md` classifies every data category as public, internal, confidential or restricted with a handling rule, and the code applies it: restricted data is column-encrypted and decrypted only for a specific permission; confidential data is masked in logs; internal data is never in storefront responses.
- Detection and exception report: Decryptions are audited.
- Acceptance: A schema check finds every column marked restricted encrypted; the storefront contract test finds no internal field; a decryption writes an audit event.
- Tests: `test/contract/aud/classification.contract.spec.ts › exposes no internal or restricted field publicly`

**SEC-029** Encryption in transit and at rest
- Owning module: AUD
- Actor: Attacker with network or disk access
- Trigger: Any connection or stored restricted value
- Control: TLS 1.3 for external traffic, a private network for internal traffic, AES-256-GCM envelope encryption in the application for bank and mobile money details, identity numbers, TOTP secrets and investor payout details, and encrypted backups and WAL with a separate key (ADR-0022).
- Detection and exception report: Key use is audited.
- Acceptance: A TLS 1.2 handshake to the API is refused; a database dump shows ciphertext for payout details; a backup restored without the backup key cannot be read.
- Tests: `test/smoke/aud/tls-and-encryption.smoke.spec.ts › refuses tls 1.2 and stores restricted fields encrypted`

**SEC-030** No card data on the server
- Owning module: PAY
- Actor: Customer
- Trigger: A card payment
- Control: Card payments use the provider's hosted or tokenised flow; no card number, expiry or CVV is accepted by any endpoint or written to any log, keeping the lowest-burden PCI self-assessment category (FR-PAY-003).
- Detection and exception report: A card-shaped value in a request is rejected.
- Acceptance: The contract has no field for a card number; submitting `4111111111111111` in a free-text field is not stored and a log scan finds none.
- Tests: `test/contract/pay/no-card-data.contract.spec.ts › accepts no card fields and logs none`

**SEC-031** Logs and traces scrubbed
- Owning module: API
- Actor: Operator
- Trigger: Any log line or trace
- Control: Secrets, tokens, full phone numbers and payment identifiers are scrubbed before they leave the process; phone numbers appear masked (`+23324*****56`).
- Detection and exception report: A scrub test runs over sample logs.
- Acceptance: A login request logged at debug shows no password or cookie; a payment log shows a masked reference; a trace span attributes contain no token.
- Tests: `test/unit/api/log-scrubbing.unit.spec.ts › removes secrets and masks phone numbers and payment ids`

**SEC-032** Tamper-evident audit log
- Owning module: AUD
- Actor: Insider
- Trigger: A change to audit rows
- Control: The audit log is append-only at the database level with update and delete privileges revoked for the application role and each row carrying a hash of the previous row (FR-AUD-002, FR-AUD-003).
- Detection and exception report: Mismatches raise `AUDIT_INTEGRITY`.
- Acceptance: Update and delete fail as the application role; a changed byte is found by the verifier.
- Tests: `test/int/aud/audit-tamper.int.spec.ts › detects a changed byte and refuses update`

**SEC-033** Log retention, time sync and incident response
- Owning module: AUD
- Actor: Responder
- Trigger: A security incident
- Control: Logs are retained long enough to investigate a dispute (365 days for application and security logs, SA-16); server time is synchronised; `docs/runbooks/incident-response.md` covers detection, containment, evidence capture, notification and recovery, with an evidence step that copies read-only and does not alter what it captures.
- Detection and exception report: The runbook is exercised once before go-live.
- Acceptance: A tabletop exercise follows the runbook from a forged-webhook alert to notification and the evidence copy hash equals the source hash.
- Tests: `test/smoke/aud/incident-response.smoke.spec.ts › follows the runbook and preserves evidence`

**SEC-034** Pipeline scanning blocks merge
- Owning module: PLT
- Actor: CI
- Trigger: Every pull request
- Control: Dependency scanning, static analysis, secret scanning and container image scanning run on every pull request and a failing high-severity finding blocks the merge; a nightly OWASP ZAP baseline runs against staging.
- Detection and exception report: Findings are visible in the pull request.
- Acceptance: A pull request adding a dependency with a known high-severity advisory fails the check; a committed fake secret fails the secret scan.
- Tests: `test/smoke/plt/ci-security-gates.smoke.spec.ts › fails a pull request with a high-severity finding`

**SEC-035** Lockfiles and software bill of materials
- Owning module: PLT
- Actor: CI
- Trigger: Every release
- Control: Lockfiles are committed, dependency updates are reviewed, and a software bill of materials is generated per release and stored with it.
- Detection and exception report: The SBOM names the commit.
- Acceptance: A release build produces an SBOM listing every package with its version; a build with a changed lockfile and no review label fails.
- Tests: `test/smoke/plt/sbom.smoke.spec.ts › generates a software bill of materials per release`

**SEC-036** Least-privilege database roles
- Owning module: PLT
- Actor: Operator
- Trigger: Any database connection
- Control: Roles are separate for the application, the worker, the sealer, reporting and migrations; the application role holds no DDL rights in production (ADR-0024); reporting can only select from its schema and published views.
- Detection and exception report: Privilege drift is checked at each deploy.
- Acceptance: The application role cannot alter a table; the reporting role cannot select from a transactional table; the sealer role cannot update an event.
- Tests: `test/int/plt/database-roles.int.spec.ts › grants only the privileges each role needs`

**SEC-037** Compliance obligations recorded and extensible
- Owning module: AUD
- Actor: Owner
- Trigger: Before go-live
- Control: The Data Protection Act registration and the revenue authority's invoicing rules are checked against official sources, with date and link, in `docs/security/COMPLIANCE.md`; consent capture, retention and subject-request flows exist; billing documents carry certified-total fields so a certification requirement can be added without reworking the document pipeline (A-061 to A-063, BL-004).
- Detection and exception report: The compliance document is dated and reviewed at each tax or privacy change.
- Acceptance: `COMPLIANCE.md` lists each obligation with a source link and date; a billing document stores optional certified totals (FR-BIL-012); a deletion request keeps statutory documents (FR-AUD-011).
- Tests: `test/smoke/aud/compliance.smoke.spec.ts › holds a dated source for each obligation`

## 6. Non-functional requirements

Each row carries a target and a way to verify it. "In CI" says whether a pipeline job runs the verification and fails the build; rows marked no are verified on the live server in B13 or by a drill and recorded in `docs/OPERATIONS.md`. NFR-001 to NFR-017 are the rows of the shared brief's non-functional table; NFR-018 to NFR-024 are its rules. The load targets are measured on the staging server sized as production (A-007) with the seeded performance dataset of NFR-011.

| Id | Attribute | Target | Verified by | In CI | Proving artefact |
| --- | --- | --- | --- | --- | --- |
| NFR-001 | API read latency | p95 under 300 ms at 50 concurrent users | k6 load test | yes | `k6/api-read-latency.js › p95 under 300 ms at 50 virtual users` |
| NFR-002 | API write latency | p95 under 600 ms at 50 concurrent users | k6 load test | yes | `k6/api-write-latency.js › p95 under 600 ms at 50 virtual users` |
| NFR-003 | POS interaction | Item added to a sale in under 100 ms locally, no network round trip required | Playwright timing assertion | yes | `playwright/pos-add-item.spec.ts › adds an item in under 100 ms with the network disabled` |
| NFR-004 | Storefront load | Largest contentful paint under 2.5 s on a simulated 3G connection | Lighthouse CI budget | yes | `lighthouse/storefront-lcp.json › lcp under 2500 ms on slow 3G` |
| NFR-005 | Catalogue page weight | Under 300 KB compressed for a listing page | Lighthouse CI budget | yes | `lighthouse/catalogue-weight.json › listing transfer size under 300 KB` |
| NFR-006 | Availability | 99.5 percent monthly; maintenance outside 06:00 to 20:00 Accra time | Uptime monitor | no | `monitor/availability-monthly › 99.5 percent of minutes up` |
| NFR-007 | Recovery point objective | 15 minutes | Continuous WAL archiving, restore drill | no | `drill/restore-rpo › restored data is at most 15 minutes behind the failure` |
| NFR-008 | Recovery time objective | 4 hours | Quarterly restore drill, timed and recorded | no | `drill/restore-rto › full restore into a clean environment in under 4 hours` |
| NFR-009 | Backups | Nightly full plus continuous archive, 30 days retained, monthly restore test | Automated job plus drill log | no | `drill/backup-monthly › latest backup restores and 30 days exist` |
| NFR-010 | Offline tolerance | POS operates 8 hours offline and queues at least 500 transactions | Integration test with the network disabled | yes | `test/e2e/pos/offline-counter.e2e.spec.ts › runs 8 hours offline and syncs 500 queued sales exactly once` |
| NFR-011 | Capacity, year one | 10,000 products, 150,000 orders, 2 million stock movements, 5 years of ledger retained online | Seeded performance dataset | yes | `k6/seed-capacity.js › targets hold on a dataset of 10,000 products 150,000 orders and 2,000,000 movements` |
| NFR-012 | Concurrency | 50 back-office users and 500 storefront sessions without degradation | Load test | yes | `k6/concurrency-mixed.js › 50 staff and 500 shop sessions meet the latency targets` |
| NFR-013 | Accessibility | WCAG 2.2 level AA on storefront and back office | axe-core in CI plus manual keyboard pass | yes | `playwright/axe-wcag22aa.spec.ts › no serious or critical axe violations on key screens` |
| NFR-014 | Browser and device | Last two versions of Chrome, Safari and Firefox, Android 9 and above, usable at 360 px width | Playwright matrix | yes | `playwright/matrix.spec.ts › key flows pass on the browser and 360 px matrix` |
| NFR-015 | Test coverage | 80 percent overall; 100 percent branch coverage on pricing, ledger, stock valuation and distribution | Coverage gate in CI | yes | `ci/coverage-gate › thresholds 80 overall and 100 branch on the four modules` |
| NFR-016 | Build and deploy | Full pipeline under 12 minutes; zero-downtime rolling deploy; migrations backward compatible for one release | Pipeline timing, deploy without a maintenance window | yes | `ci/pipeline-timing › full pipeline under 12 minutes` |
| NFR-017 | Local setup | A new developer runs the whole stack with one command | Fresh-clone CI job that runs the setup script | yes | `ci/fresh-clone › setup script brings the stack up on a clean checkout` |
| NFR-018 | Maintainability: module boundaries | No module imports another module's internals | Import-boundary lint rule failing the build | yes | `ci/import-boundaries › build fails on a cross-module internal import` |
| NFR-019 | Observability: correlation ids | Every request carries a correlation id that appears in logs, traces and any error shown to a user | Integration test and log assertion | yes | `test/int/platform/correlation-id.int.spec.ts › one id appears in the response the log and the trace` |
| NFR-020 | Operability: runbooks | Every failure mode named in the threat model and the architecture has a runbook in `docs/runbooks/` with symptoms, diagnosis and fix | Runbook check in CI plus a tabletop | yes | `ci/runbook-coverage › every named failure mode has a runbook file` |
| NFR-021 | Portability | Nothing ties the application to one cloud vendor; object storage is S3-compatible; no proprietary managed service | Dependency and configuration review in CI | yes | `ci/portability › the stack starts with only S3-compatible storage and no vendor service` |
| NFR-022 | Localisation readiness | All user-facing strings go through a translation layer; English ships first | Lint rule and a pseudo-locale test | yes | `ci/i18n-lint › no hard-coded user-facing string in API messages or templates` |
| NFR-023 | Low-bandwidth discipline | Responsive and lazy images, paginated lists, no screen needs more than one round trip to become useful | Contract test plus Lighthouse budget | yes | `test/contract/platform/low-bandwidth.contract.spec.ts › every list is paginated and every screen endpoint returns a complete view` |
| NFR-024 | Cost | Year-one infrastructure under 150 US dollars a month at the capacity targets, with a running estimate in `docs/OPERATIONS.md` | Cost estimate review at release | no | `review/cost-estimate › estimate under 150 USD a month at the NFR-011 capacity` |

**NFR-001** API read latency. Reads are the catalogue, stock on hand, order lists and ledger reports over the seeded dataset, run for 5 minutes after a 1-minute ramp. The run fails the pipeline if p95 is 300 ms or more or the error rate exceeds 0.1 percent.

**NFR-002** API write latency. Writes are counter sales, goods receipts, payments and order placement, each with an idempotency key. Heavy reports run concurrently to prove isolation (FR-RPT-009).

**NFR-003** POS interaction. The assertion runs with the browser context offline and measures from scan input to the line appearing, median of 20 runs under 100 ms and no run above 150 ms.

**NFR-004** Storefront load. Measured on the catalogue listing, a product page and the cart, mobile profile, 1.6 Mbps down, 150 ms round trip, median of 5 runs.

**NFR-005** Catalogue page weight. Counts all bytes transferred for the first 24 products with images lazy-loaded at responsive widths (FR-DOC-005).

**NFR-006** Availability. 99.5 percent allows about 3 hours 36 minutes of downtime in a 30-day month. The health endpoint (FR-API-014) is the probe; maintenance windows are announced and fall between 20:00 and 06:00.

**NFR-007** Recovery point objective. Archive age is on the health endpoint and alerts above 10 minutes. The drill kills the primary at a known write and compares the last restored transaction.

**NFR-008** Recovery time objective. The drill follows `docs/runbooks/restore-from-backup.md`, restores into a clean environment, verifies the trial balance and a sample decryption, and writes the elapsed time into `docs/OPERATIONS.md` (FR-AUD-012).

**NFR-009** Backups. A job checks every night that 30 daily fulls and the WAL chain between them exist; a monthly job restores the latest into a scratch database and reports the result.

**NFR-010** Offline tolerance. The clock is advanced 8 hours in the device test, 500 cash sales are queued, the network returns, and all 500 sync exactly once (FR-POS-010, FR-POS-011); the staff refresh lifetime covers the shift (FR-IAM-016).

**NFR-011** Capacity, year one. The seeded dataset is generated by the factory and is the data under which NFR-001 and NFR-002 run. No table is partitioned in version one (A-068); the run records table sizes and vacuum behaviour.

**NFR-012** Concurrency. A mixed scenario runs both populations together; degradation means any NFR-001 or NFR-002 target missed or an error rate above 0.1 percent.

**NFR-013** Accessibility. The API returns errors, labels and codes in forms a screen reader can announce; the frontend repository owns the screens. The manual keyboard pass is recorded in the session report.

**NFR-014** Browser and device. The matrix runs the storefront checkout, the POS sale and the driver proof flow.

**NFR-015** Test coverage. The gate is set in B2 and enforced from the first module; the four modules are the pricing engine and tax calculator, the journal and posting rules, weighted-average and specific-identification valuation, and the distribution allocation.

**NFR-016** Build and deploy. The smoke suite runs against the new containers before traffic switches and rolls back without a human on failure; each migration follows expand then contract and has a tested rollback or a documented forward fix.

**NFR-017** Local setup. The job clones into an empty directory, runs the documented command and checks the health endpoint and one seeded read.

**NFR-018** Maintainability: module boundaries. The rule is `eslint-plugin-boundaries` (MODULE_BOUNDARIES section 7) plus the two data checks; a deliberate violation in a test branch must fail.

**NFR-019** Observability: correlation ids. A request with no id receives one; a request with an id keeps it (validated as a UUID); error envelopes carry it (FR-API-003).

**NFR-020** Operability: runbooks. At minimum: payment provider down, database failover, restore from backup, reconciliation break, queue backlog, incident response. The check lists the failure modes from the architecture and fails on a missing file.

**NFR-021** Portability. Development and CI use an S3-compatible object store in a container (Versity Gateway, ADR-0032); the check starts the stack with no cloud credentials.

**NFR-022** Localisation readiness. The API's error messages, notification templates and document labels come from message catalogues; a pseudo-locale run shows no untranslated string.

**NFR-023** Low-bandwidth discipline. Lists carry cursor pagination with a default of 25 and a maximum of 100; screen-level endpoints (dashboard, driver route, checkout) return everything the first paint needs in one response.

**NFR-024** Cost. The estimate lists the production server, the staging server, object storage, off-box backups and the domain, and is updated at every release.

## 7. Traceability matrix and counts

### 7.1 How to read the matrix

One row per requirement. Rows are grouped by module; security requirements and the non-functional requirements that belong to a module (POS interaction, storefront) follow its functional requirements, and the remaining cross-cutting requirements are in the last group, PLT. The session column names the session whose gate proves the requirement. The 18 abuse-case requirements are proven in B13, which also depends on the daily exception report that ADR-0026 assigns to B12 (FR-RPT-007). The test column names the layer and stable test name under the convention `test/<layer>/<module>/<subject>.<layer>.spec.ts › <behaviour>`; non-functional rows name the k6 script, Lighthouse budget, Playwright test or drill. The operations column lists the operationIds in `contract/openapi.yaml` 1.0.0 that the requirement touches; a dash means the requirement is not exposed as an operation. Assignments marked "(ADR-0026)" come from the amended schedule, confirmed by the owner on 2026-11-13 (A-040).

### 7.2 Matrix

#### IAM: Identity, access and roles

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-IAM-001 | B3 | `test/int/iam/staff-accounts.int.spec.ts › refuses a duplicate live phone or email in the same realm` | createUser, listUsers, getUser, updateUser |
| FR-IAM-002 | B3 | `test/int/iam/staff-login.int.spec.ts › returns an identical failure for unknown, wrong and disabled accounts` | loginStaff, getCurrentSession |
| FR-IAM-003 | B3 | `test/unit/iam/password-hashing.unit.spec.ts › stores argon2id with a unique salt and rehashes on parameter change` | loginStaff |
| FR-IAM-004 | B3 | `test/int/iam/forced-password-change.int.spec.ts › blocks every operation except password change until changed` | changePassword, loginStaff |
| FR-IAM-005 | B3 | `test/int/iam/password-policy.int.spec.ts › refuses breached passwords and falls back to the bundled list` | changePassword, resetPassword |
| FR-IAM-006 | B3 | `test/int/iam/totp.int.spec.ts › requires a verified second factor for owner, accountant and manager` | startTotpEnrolment, confirmTotpEnrolment, verifyTotp, loginStaff |
| FR-IAM-007 | B3 | `test/int/iam/step-up.int.spec.ts › refuses sensitive actions without a step-up in the last five minutes` | stepUp, postDistributionRun, createExportJob, createGrant, createPostingRule |
| FR-IAM-008 | B3 | `test/int/iam/roles-seed.int.spec.ts › seeds ten system roles and every contract permission` | listRoles, createRole, getRole, updateRole, listPermissions |
| FR-IAM-009 | B3 | `test/unit/iam/policy-engine.unit.spec.ts › refuses every handler that does not declare a permission` | listGrants, createManualJournal |
| FR-IAM-010 | B3 | `test/int/iam/ownership.int.spec.ts › refuses a record owned by another principal` | getMyOrder, getMyDelivery, getMyInvestorSummary, getShift |
| FR-IAM-011 | B3 | `test/int/iam/grant-scope.int.spec.ts › refuses an action outside the grant's branch or location` | createGrant, revokeGrant, listGrants, createGoodsReceipt |
| FR-IAM-012 | B3 | `test/int/iam/approvals.int.spec.ts › refuses a self-approval and voids an approval whose payload changed` | listApprovals, getApproval, approveRequest, rejectRequest, cancelApprovalRequest |
| FR-IAM-013 | B3 | `test/int/iam/investor-isolation.int.spec.ts › returns only the caller's own data and refuses all other operations` | loginInvestor, getMyInvestorSummary, listMyCapitalTransactions, listMyDistributions, getMyInvestorStatement, listMyInvestorDocuments |
| FR-IAM-014 | B3 | `test/int/iam/sessions.int.spec.ts › lists devices and revokes a session without deleting it` | listSessions, revokeSession, logout |
| FR-IAM-015 | B3 | `test/int/iam/forced-logout.int.spec.ts › disabling a user revokes all of their sessions` | revokeSession, disableUser, enableUser, listSessions |
| FR-IAM-016 | B3 | `test/int/iam/token-rotation.int.spec.ts › revokes the session when a rotated refresh token is reused` | refreshSession, logout |
| FR-IAM-017 | B3 | `test/unit/iam/lockout.unit.spec.ts › doubles the lock period per failure and caps it at sixty minutes` | loginStaff, unlockUser |
| FR-IAM-018 | B3 | `test/int/iam/auth-audit.int.spec.ts › records every authentication event without secrets` | listAuditEvents, loginStaff |
| FR-IAM-019 | B3 | `test/int/iam/customer-realm.int.spec.ts › registers, verifies and isolates the customer realm` | registerCustomer, verifyCustomerPhone, loginCustomer |
| FR-IAM-020 | B3 | `test/int/iam/password-reset.int.spec.ts › answers identically and revokes sessions on use` | requestPasswordReset, resetPassword, resetUserPassword |
| FR-IAM-021 | B3 | `test/int/iam/approval-policy.int.spec.ts › applies the threshold at or above the policy value` | listApprovalPolicies, updateApprovalPolicy |
| FR-IAM-022 | B3 | `test/int/iam/grant-controls.int.spec.ts › refuses self-grants and reports every grant change` | createGrant, revokeGrant, updateRole, getDailyExceptionReport |
| SEC-008 | B13 | `test/e2e/iam/abuse-08-investor-access.e2e.spec.ts › refuses finance and other investors' data`<br>`test/e2e/iam/abuse-08-investor-access.e2e.spec.ts › reports each refusal as AUTHORISATION_FAILURE with abuse case 8` | getTrialBalance, getMyInvestorStatement, getDailyExceptionReport |
| SEC-016 | B13 | `test/e2e/iam/abuse-16-role-escalation.e2e.spec.ts › refuses a self-grant and a grant without step-up`<br>`test/e2e/iam/abuse-16-role-escalation.e2e.spec.ts › reports every grant as PERMISSION_CHANGE with abuse case 16` | createGrant, revokeGrant, updateRole, getDailyExceptionReport |
| SEC-019 | B3 | `test/unit/iam/authorisation-coverage.unit.spec.ts › fails the build for a handler without a declared permission`<br>`test/int/iam/ownership.int.spec.ts › refuses every module's records to a non-owner` | listGrants |
| SEC-020 | B3 | `test/int/iam/separation-of-duties.int.spec.ts › refuses a self-approval for each of the six kinds` | approveRequest, listApprovals |
| SEC-021 | B3 | `test/int/iam/mfa-and-step-up.int.spec.ts › requires totp at login and fresh step-up for sensitive actions` | verifyTotp, stepUp |
| SEC-022 | B3 | `test/int/iam/no-enumeration.int.spec.ts › returns identical responses for known and unknown accounts` | loginStaff, requestPasswordReset, registerCustomer |

#### MDM: Master data, pricing and tax

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-MDM-001 | B4 | `test/int/mdm/product-policy.int.spec.ts › refuses a policy change once movements exist` | createProduct, getProduct, updateProduct, listProducts, archiveProduct |
| FR-MDM-002 | B4 | `test/int/mdm/categories.int.spec.ts › refuses to archive a category that is still in use` | listCategories, createCategory, getCategory, updateCategory, archiveCategory |
| FR-MDM-003 | B4 | `test/unit/mdm/unit-conversion.unit.spec.ts › converts packs and crates exactly and refuses inexact factors` | listUnitsOfMeasure, updateProduct |
| FR-MDM-004 | B4 | `test/int/mdm/product-media.int.spec.ts › lists only visible products and refuses non-image uploads` | addProductImage, removeProductImage, listCatalogue |
| FR-MDM-005 | B4 | `test/int/mdm/weight-bands.int.spec.ts › rejects overlapping bands and maps a weight to one band` | listSpeciesList, createSpecies, updateSpecies, listGrades, createGrade, updateGrade, archiveGrade, listWeightBands, createWeightBand, updateWeightBand, archiveWeightBand |
| FR-MDM-006 | B4 | `test/int/mdm/locations.int.spec.ts › keeps parent and child in one branch` | listBranches, createBranch, getBranch, updateBranch, listLocations, createLocation, getLocation, updateLocation, archiveLocation |
| FR-MDM-007 | B4 | `test/int/mdm/supplier-identity.int.spec.ts › refuses duplicate live suppliers` | listSuppliers, createSupplier, getSupplier, updateSupplier, archiveSupplier |
| FR-MDM-008 | B4 | `test/int/mdm/customers.int.spec.ts › normalises Ghana phone numbers and refuses duplicates` | listCustomers, createCustomer, getCustomer, updateCustomer, archiveCustomer, listCustomerTiers, createCustomerTier, listCustomerAddresses, createCustomerAddress, updateCustomerAddress, archiveCustomerAddress |
| FR-MDM-009 | B4 | `test/int/mdm/payment-methods.int.spec.ts › keeps verification mandatory for mobile money and card` | listPaymentMethods, updatePaymentMethod |
| FR-MDM-010 | B4 | `test/int/mdm/delivery-zones.int.spec.ts › returns the zone fee or unavailable` | listDeliveryZones, createDeliveryZone, getDeliveryZone, updateDeliveryZone, quoteDelivery |
| FR-MDM-011 | B4 | `test/int/mdm/reason-codes.int.spec.ts › accepts only codes from the fixed list` | listReasonCodes |
| FR-MDM-012 | B4 | `test/int/mdm/tax-scheme.int.spec.ts › refuses an incomplete matrix and freezes an active version` | listTaxLevies, createTaxLevy, listTaxCategories, createTaxCategory, listTaxSchemeVersions, createTaxSchemeVersion, getTaxSchemeVersion, replaceTaxSchemeCells, submitTaxSchemeVersion |
| FR-MDM-013 | B4 | `test/unit/mdm/tax-calculator.unit.spec.ts › computes levies on a tax-exclusive line with no compounding` | calculateTax |
| FR-MDM-014 | B4 | `test/unit/mdm/tax-calculator.unit.spec.ts › splits an inclusive gross into parts that sum exactly` | calculateTax |
| FR-MDM-015 | B4 | `test/int/mdm/price-list-versions.int.spec.ts › needs a second approver and refuses overlap` | listPriceLists, createPriceList, getPriceList, updatePriceList, archivePriceList, listPriceListVersions, createPriceListVersion, getPriceListVersion, listPriceListEntries, replacePriceListEntries, submitPriceListVersion |
| FR-MDM-016 | B4 | `test/unit/mdm/pricing-engine.unit.spec.ts › resolves by precedence, specificity and quote-only` | resolvePrices |
| FR-MDM-017 | B4 | `test/unit/mdm/pricing-engine.unit.spec.ts › records variance and returns quote-required instead of an error` | resolvePrices, completeCounterSale |
| FR-MDM-018 | B4 | `test/int/mdm/promotions.int.spec.ts › enforces stacking rules and coupon limits under concurrency` | listPromotions, createPromotion, getPromotion, updatePromotion, submitPromotion, endPromotion, listCoupons, createCoupon, validateCoupon |
| FR-MDM-019 | B4 | `test/int/mdm/import-jobs.int.spec.ts › writes nothing in a dry run and applies all or none` | listImportJobs, createImportJob, getImportJob, listImportErrors, applyImportJob, cancelImportJob |
| FR-MDM-020 | B4 | `test/int/mdm/master-data-export.int.spec.ts › audits row counts and demands step-up above 100 rows` | createExportJob |
| FR-MDM-021 | B4 | `test/int/mdm/customer-price-list.int.spec.ts › applies the assigned list first` | assignCustomerPriceList, resolvePrices |

#### LIV: Livestock management

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-LIV-001 | B6 | `test/int/liv/animal-register.int.spec.ts › registers one animal per tag and refuses a duplicate live tag` | listAnimals, getAnimal, createGoodsReceipt, postGoodsReceipt |
| FR-LIV-002 | B6 | `test/int/liv/animal-edit.int.spec.ts › locks fixed attributes and applies purpose to cost treatment` | updateAnimal |
| FR-LIV-003 | B6 | `test/int/liv/animal-move.int.spec.ts › moves a serial unit from its current location only` | moveAnimal, listAnimalTimeline |
| FR-LIV-004 | B6 | `test/int/liv/weight-records.int.spec.ts › requires a source and refuses records for closed animals` | recordWeights, listWeightRecords, listAnimalTimeline |
| FR-LIV-005 | B6 | `test/unit/liv/average-daily-gain.unit.spec.ts › computes per-animal and per-group gain` | listGrowth, listWeightRecords |
| FR-LIV-006 | B6 | `test/int/liv/batches.int.spec.ts › closes only when empty` | listBatches, createBatch, getBatch, updateBatch, closeBatch |
| FR-LIV-007 | B6 | `test/int/liv/health-events.int.spec.ts › records treatment and issues medication from stock` | recordHealthEvent, listHealthEvents, getHealthEvent |
| FR-LIV-008 | B6 | `test/int/liv/withdrawal-hold.int.spec.ts › blocks sale and processing until the hold ends` | recordHealthEvent, createStockHold, releaseStockHold, completeCounterSale |
| FR-LIV-009 | B6 | `test/unit/liv/cost-allocation.unit.spec.ts › spreads veterinary cost with no pesewa lost` | recordHealthEvent, getCostObject |
| FR-LIV-010 | B6 | `test/int/liv/breeding-record.int.spec.ts › computes expected birth and validates the dam` | listBreedingRecords, createBreedingRecord, getBreedingRecord, updateBreedingRecord, failBreedingRecord |
| FR-LIV-011 | B6 | `test/int/liv/birth-record.int.spec.ts › registers offspring at nil cost linked to the dam` | recordBirth, getBreedingRecord, listAnimals |
| FR-LIV-012 | B6 | `test/int/liv/mortality-approval.int.spec.ts › needs photo and second approver at or above the threshold` | reportMortality, submitMortalityRecord, listMortalityRecords, getMortalityRecord, approveRequest |
| FR-LIV-013 | B8 | `test/int/liv/mortality-posting.int.spec.ts › posts the whole accumulated cost to 5100` | submitMortalityRecord, getTrialBalance |
| FR-LIV-014 | B6 | `test/unit/liv/ration-expected-consumption.unit.spec.ts › multiplies per-head quantity by head-days` | listRations, createRation, updateRation |
| FR-LIV-015 | B6 | `test/int/liv/feed-allocation.int.spec.ts › allocates feed value to the pen exactly` | recordFeedConsumption, listFeedConsumption, getFeedConsumption |
| FR-LIV-016 | B6 | `test/unit/liv/feed-conversion.unit.spec.ts › computes the ratio from feed and gain` | listGrowth, getCostObject |
| FR-LIV-017 | B6 | `test/int/liv/animal-status.int.spec.ts › updates status in the sale transaction and refuses a second sale` | listAnimals, completeCounterSale |
| SEC-002 | B13 | `test/e2e/liv/abuse-02-mortality.e2e.spec.ts › blocks an unapproved high-value write-off`<br>`test/e2e/liv/abuse-02-mortality.e2e.spec.ts › reports the mortality as MORTALITY with abuse case 2` | reportMortality, submitMortalityRecord, approveRequest, getDailyExceptionReport |

#### INV: Inventory and stock control

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-INV-001 | B5 | `test/int/inv/movement-ledger.int.spec.ts › rejects update delete and truncate of a movement` | listStockMovements, getStockMovement |
| FR-INV-002 | B5 | `test/int/inv/movement-shape.int.spec.ts › enforces locations quantity and weight-source checks` | listStockMovements, listMovementTypes |
| FR-INV-003 | B5 | `test/int/inv/balance-recompute.int.spec.ts › detects drift and never auto-corrects` | listStockOnHand, listStockAvailability, listStockExceptions |
| FR-INV-004 | B5 | `test/int/inv/movement-reversal.int.spec.ts › reverses once with the original value` | reverseStockMovement, getStockMovement |
| FR-INV-005 | B5 | `test/int/inv/lots.int.spec.ts › enforces batch uniqueness and date order` | listStockUnits, getStockUnit |
| FR-INV-006 | B5 | `test/int/inv/traceability.int.spec.ts › traces a sold lot back to the animal and supplier` | traceStockUnit, listStockUnitMovements |
| FR-INV-007 | B5 | `test/int/inv/temperature-log.int.spec.ts › records readings against the location range` | recordTemperatureReading, listTemperatureReadings |
| FR-INV-008 | B5 | `test/int/inv/cold-chain-quarantine.int.spec.ts › quarantines every lot in the room on an excursion` | recordTemperatureReading, createStockHold, releaseStockHold, listStockHolds |
| FR-INV-009 | B5 | `test/int/inv/goods-receipt.int.spec.ts › posts movements and freezes the document` | listGoodsReceipts, createGoodsReceipt, getGoodsReceipt, updateGoodsReceipt, postGoodsReceipt, cancelGoodsReceipt |
| FR-INV-010 | B5 | `test/int/inv/stock-transfer.int.spec.ts › moves stock through in-transit and keeps value` | listStockTransfers, createStockTransfer, getStockTransfer, dispatchStockTransfer, cancelStockTransfer |
| FR-INV-011 | B5 | `test/int/inv/transfer-receipt.int.spec.ts › balances received and variance to dispatched` | receiveStockTransfer |
| FR-INV-012 | B5 | `test/int/inv/stock-adjustment.int.spec.ts › needs approval at or above the threshold` | listStockAdjustments, createStockAdjustment, getStockAdjustment, submitStockAdjustment |
| FR-INV-013 | B5 | `test/int/inv/stock-take.int.spec.ts › posts variances from blind counts` | listStockTakes, createStockTake, getStockTake, startStockTake, listStockTakeLines, recordStockTakeCounts, closeStockTakeCounting, submitStockTake, cancelStockTake |
| FR-INV-014 | B5 | `test/int/inv/cycle-count.int.spec.ts › refuses overlapping scopes` | createStockTake, startStockTake |
| FR-INV-015 | B5 | `test/int/inv/reorder-alerts.int.spec.ts › raises one alert per crossing` | listReorderRules, createReorderRule, updateReorderRule, listStockAlerts |
| FR-INV-016 | B5 | `test/int/inv/expiry-alerts.int.spec.ts › alerts before expiry and blocks sale after` | listStockAlerts, listStockUnits |
| FR-INV-017 | B5 | `test/unit/inv/weighted-average-cost.unit.spec.ts › issues with half-up and empties the pool exactly` | listStockOnHand |
| FR-INV-018 | B5 | `test/int/inv/specific-identification.int.spec.ts › issues the animal's own accumulated cost` | getStockUnit, getCostObject |
| FR-INV-019 | B5 | `test/int/inv/negative-stock.int.spec.ts › refuses except for allowed offline movements` | createGoodsReceipt, syncOfflineSales, listStockExceptions |
| FR-INV-020 | B5 | `test/int/inv/serial-unit.int.spec.ts › allows exactly one concurrent sale` | completeCounterSale, traceStockUnit |
| FR-INV-021 | B5 | `test/int/inv/reservations.int.spec.ts › allows one active reservation per animal and expires on time` | listStockReservations, releaseStockReservation, listStockAvailability |
| FR-INV-022 | B5 | `test/int/inv/stock-holds.int.spec.ts › blocks listed movement types until released` | listStockHolds, createStockHold, releaseStockHold |
| FR-INV-023 | B5 | `test/int/inv/stock-exceptions.int.spec.ts › records resolves and reports a conflict` | listStockExceptions, getStockException, resolveStockException |
| FR-INV-024 | B5 | `test/int/inv/numeric-constraints.int.spec.ts › rejects out-of-range values at the database` | listStockMovements |
| FR-INV-025 | B5 | `test/int/inv/serializable-reservation.int.spec.ts › yields exactly the available quantity under contention` | createStockHold, listStockReservations |
| SEC-007 | B13 | `test/e2e/inv/abuse-07-stock-adjustment.e2e.spec.ts › blocks an unapproved adjustment and an unlisted reason`<br>`test/e2e/inv/abuse-07-stock-adjustment.e2e.spec.ts › reports the adjustment as STOCK_ADJUSTMENT with abuse case 7` | createStockAdjustment, submitStockAdjustment, approveRequest, getDailyExceptionReport |
| SEC-011 | B13 | `test/e2e/inv/abuse-11-serial-conflict.e2e.spec.ts › refuses a second movement of a sold animal`<br>`test/e2e/inv/abuse-11-serial-conflict.e2e.spec.ts › reports the conflict as STOCK_EXCEPTION with abuse case 11` | syncOfflineSales, listStockExceptions, getDailyExceptionReport |

#### PRC: Processing and production

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-PRC-001 | B6 | `test/int/prc/processing-start.int.spec.ts › refuses held sold or absent inputs` | listProcessingOrders, createProcessingOrder, getProcessingOrder, updateProcessingOrder, startProcessingOrder |
| FR-PRC-002 | B6 | `test/unit/prc/processing-outputs.unit.spec.ts › refuses output weight above input weight` | recordProcessingOutputs |
| FR-PRC-003 | B6 | `test/int/prc/processing-complete.int.spec.ts › consumes inputs and creates linked output lots` | completeProcessingOrder, traceStockUnit |
| FR-PRC-004 | B6 | `test/unit/prc/yield.unit.spec.ts › computes expected actual and variance` | listYieldStandards, createYieldStandard, updateYieldStandard, getProcessingOrder |
| FR-PRC-005 | B6 | `test/int/prc/yield-variance.int.spec.ts › flags beyond five percent and reports it` | completeProcessingOrder, getDailyExceptionReport |
| FR-PRC-006 | B6 | `test/int/prc/processing-cost.int.spec.ts › adds direct cost to the total to allocate` | addProcessingCost |
| FR-PRC-007 | B6 | `test/unit/prc/cost-allocation.unit.spec.ts › allocates processing cost by relative sales value exactly` | completeProcessingOrder, getCostObject |
| FR-PRC-008 | B6 | `test/unit/prc/waste-cost.unit.spec.ts › gives waste zero cost` | recordProcessingOutputs |
| FR-PRC-009 | B6 | `test/int/prc/packing.int.spec.ts › keeps pack weights equal to the lot weight` | listPacks, createPacks |
| FR-PRC-010 | B6 | `test/unit/prc/pack-label.unit.spec.ts › encodes lot and weight in the barcode payload` | printPackLabels, listPacks |
| FR-PRC-011 | B6 | `test/int/prc/processing-freeze.int.spec.ts › refuses edits and reverses only unsold outputs` | cancelProcessingOrder, updateProcessingOrder |
| SEC-018 | B13 | `test/e2e/prc/abuse-18-yield.e2e.spec.ts › flags a yield shortfall beyond tolerance`<br>`test/e2e/prc/abuse-18-yield.e2e.spec.ts › reports the shortfall as YIELD_VARIANCE with abuse case 18` | completeProcessingOrder, getDailyExceptionReport |

#### PUR: Procurement and suppliers

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-PUR-001 | B7 | `test/int/pur/supplier-profile.int.spec.ts › stores terms and masks payout details` | getSupplierProfile, updateSupplierProfile |
| FR-PUR-002 | B7 | `test/int/pur/payout-details.int.spec.ts › encrypts and requires a second approver for a change` | updateSupplierProfile, approveRequest |
| FR-PUR-003 | B7 | `test/int/pur/supplier-documents.int.spec.ts › stores privately and refuses disguised files` | listSupplierDocuments, addSupplierDocument |
| FR-PUR-004 | B7 | `test/int/pur/requisitions.int.spec.ts › converts or rejects a submitted requisition` | listPurchaseRequisitions, createPurchaseRequisition, getPurchaseRequisition, updatePurchaseRequisition, submitPurchaseRequisition, rejectPurchaseRequisition, convertPurchaseRequisition |
| FR-PUR-005 | B7 | `test/int/pur/purchase-order-approval.int.spec.ts › needs a second approver above the limit` | listPurchaseOrders, createPurchaseOrder, getPurchaseOrder, updatePurchaseOrder, submitPurchaseOrder, approveRequest |
| FR-PUR-006 | B7 | `test/int/pur/purchase-order-lifecycle.int.spec.ts › cancels only before receipt` | sendPurchaseOrder, closePurchaseOrder, cancelPurchaseOrder |
| FR-PUR-007 | B7 | `test/int/pur/partial-receipt.int.spec.ts › tracks outstanding and refuses over-receipt` | postGoodsReceipt, getPurchaseOrder |
| FR-PUR-008 | B7 | `test/int/pur/supplier-invoice.int.spec.ts › refuses a duplicate number per supplier` | listSupplierInvoices, createSupplierInvoice, getSupplierInvoice, updateSupplierInvoice, cancelSupplierInvoice |
| FR-PUR-009 | B7 | `test/unit/pur/three-way-match.unit.spec.ts › applies the price and quantity tolerances` | matchSupplierInvoice |
| FR-PUR-010 | B7 | `test/int/pur/payment-block.int.spec.ts › refuses payment of an unmatched invoice` | approveSupplierInvoice, createSupplierPayment |
| FR-PUR-011 | B7 | `test/int/pur/supplier-credit-note.int.spec.ts › cannot exceed the invoice` | createSupplierInvoice, getSupplierInvoice |
| FR-PUR-012 | B7 | `test/int/pur/supplier-payment.int.spec.ts › allocates within limits with a second approver` | listSupplierPayments, createSupplierPayment, getSupplierPayment, submitSupplierPayment, markSupplierPaymentPaid, cancelSupplierPayment |
| FR-PUR-013 | B7 | `test/int/pur/remittance.int.spec.ts › sends one advice per payment` | markSupplierPaymentPaid, listArchivedDocuments |
| FR-PUR-014 | B7 | `test/unit/pur/supplier-score.unit.spec.ts › combines the four components with weights` | listSupplierScores |
| FR-PUR-015 | B8 | `test/int/pur/purchase-posting.int.spec.ts › posts receipt invoice and price variance` | getTrialBalance, matchSupplierInvoice |
| SEC-013 | B13 | `test/e2e/pur/abuse-13-payout-change.e2e.spec.ts › holds a payout change until a different user approves`<br>`test/e2e/pur/abuse-13-payout-change.e2e.spec.ts › reports the change as PAYOUT_DETAIL_CHANGE with abuse case 13` | updateSupplierProfile, approveRequest, createSupplierPayment, getDailyExceptionReport |

#### POS: Retail point of sale

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-POS-001 | B9b | `test/int/pos/counter-sale.int.spec.ts › posts stock receipt payment and ledger atomically` | completeCounterSale, getOrder |
| FR-POS-002 | B9b | `test/unit/pos/catch-weight-line.unit.spec.ts › rounds half-up once at the line total` | completeCounterSale |
| FR-POS-003 | B9b | `test/int/pos/counter-pricing.int.spec.ts › refuses an unresolved price and offers a quote` | resolvePrices, completeCounterSale, createQuote |
| FR-POS-004 | B9b | `test/int/pos/price-override.int.spec.ts › applies line and shift limits and posts to 4210` | completeCounterSale, approveRequest |
| FR-POS-005 | B9b | `test/unit/pos/tender-allocation.unit.spec.ts › requires tenders to cover the total and limits change to cash` | completeCounterSale, getCustomerStoreCredit |
| FR-POS-006 | B9b | `test/int/pos/verified-tender.int.spec.ts › refuses a client-asserted cleared mobile money tender` | completeCounterSale, initiateMobileMoneyCharge, checkPaymentStatus |
| FR-POS-007 | B9b | `test/int/pos/held-sales.int.spec.ts › holds recalls and re-prices` | listHeldSales, holdSale, recallHeldSale |
| FR-POS-008 | B9b | `test/int/pos/return-against-receipt.int.spec.ts › cannot exceed the quantity sold` | listReturns, createReturn, getReturn, submitReturn, requestRefund, issueCreditNote |
| FR-POS-009 | B9b | `test/int/pos/sale-void.int.spec.ts › needs a different supervisor and reverses stock billing and payment` | voidOrder, approveRequest, getDailyExceptionReport |
| FR-POS-010 | B9b | `test/e2e/pos/offline-counter.e2e.spec.ts › runs 8 hours offline and queues 500 cash sales` | getOfflinePack, enrolDevice, listRegisterDevices, revokeDevice |
| FR-POS-011 | B9b | `test/int/pos/offline-sync.int.spec.ts › posts each client id exactly once` | syncOfflineSales |
| FR-POS-012 | B9b | `test/int/pos/offline-conflicts.int.spec.ts › flags stock conflicts instead of failing or hiding them` | syncOfflineSales, listStockExceptions |
| FR-POS-013 | B9b | `test/int/pos/device-counter.int.spec.ts › raises an exception for a missing counter` | syncOfflineSales, getDailyExceptionReport |
| FR-POS-014 | B9b | `test/int/pos/offline-late-sale.int.spec.ts › posts on the first open date and keeps occurred-at` | syncOfflineSales |
| FR-POS-015 | B9b | `test/int/pos/shift-open.int.spec.ts › allows one open shift per register and per cashier` | openShift, listShifts, getShift |
| FR-POS-016 | B9b | `test/int/pos/cash-movements.int.spec.ts › reduces expected cash with a reason` | recordCashMovement, listShiftCashMovements |
| FR-POS-017 | B9b | `test/int/pos/shift-reports.int.spec.ts › totals tenders exactly and freezes the Z report` | getShiftXReport, getShiftZReport |
| FR-POS-018 | B9b | `test/int/pos/blind-close.int.spec.ts › hides expected cash until declared` | closeShift, approveShiftClose, getShift |
| FR-POS-019 | B9b | `test/unit/pos/over-short.unit.spec.ts › computes declared minus expected and posts to 6900` | closeShift, getDailyExceptionReport |
| FR-POS-020 | B9b | `test/int/pos/force-close.int.spec.ts › closes with a reason and flags late syncs` | forceCloseShift |
| FR-POS-021 | B9b | `test/e2e/pos/receipt-printing.e2e.spec.ts › prints archived content with a reprint marker` | getBillingDocument, reprintBillingDocument |
| FR-POS-022 | B11 | `test/int/pos/receipt-delivery.int.spec.ts › queues one message per sale in the outbox` | sendBillingDocument |
| SEC-001 | B13 | `test/e2e/pos/abuse-01-sale-void.e2e.spec.ts › blocks a self-approved void and keeps an immutable record`<br>`test/e2e/pos/abuse-01-sale-void.e2e.spec.ts › reports the void as SALE_VOID with abuse case 1` | voidOrder, approveRequest, getDailyExceptionReport |
| SEC-003 | B13 | `test/e2e/pos/abuse-03-price-override.e2e.spec.ts › refuses overrides beyond the shift limit`<br>`test/e2e/pos/abuse-03-price-override.e2e.spec.ts › reports override value per user per shift as PRICE_OVERRIDE` | completeCounterSale, getDailyExceptionReport |
| SEC-010 | B13 | `test/e2e/pos/abuse-10-counter-gap.e2e.spec.ts › detects a missing device counter at sync`<br>`test/e2e/pos/abuse-10-counter-gap.e2e.spec.ts › reports the gap as DEVICE_COUNTER_GAP with abuse case 10` | syncOfflineSales, getDailyExceptionReport |
| SEC-017 | B13 | `test/e2e/pos/abuse-17-shift-short.e2e.spec.ts › hides expected cash and posts the shortage`<br>`test/e2e/pos/abuse-17-shift-short.e2e.spec.ts › reports the difference as SHIFT_OVER_SHORT with abuse case 17` | closeShift, approveShiftClose, getDailyExceptionReport |
| NFR-003 | B9b | `playwright/pos-add-item.spec.ts › adds an item in under 100 ms with the network disabled` | - |
| NFR-010 | B9b | `test/e2e/pos/offline-counter.e2e.spec.ts › runs 8 hours offline and syncs 500 queued sales exactly once` | - |

#### WHL: Wholesale and business accounts

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-WHL-001 | B10 | `test/int/whl/business-account.int.spec.ts › holds limit terms list and manager` | listBusinessAccounts, createBusinessAccount, getBusinessAccount, updateBusinessAccount, assignCustomerPriceList |
| FR-WHL-002 | B10 | `test/unit/whl/due-date.unit.spec.ts › adds terms in calendar days` | getBusinessAccount, getBillingDocument |
| FR-WHL-003 | B10 | `test/int/whl/bulk-order.int.spec.ts › prices lines from the account list and holds unpriced lines` | createOrder, getOrder, resolvePrices |
| FR-WHL-004 | B10 | `test/int/whl/standing-orders.int.spec.ts › generates one order per occurrence` | listStandingOrders, createStandingOrder, getStandingOrder, updateStandingOrder, pauseStandingOrder, resumeStandingOrder, endStandingOrder, listStandingOrderRuns |
| FR-WHL-005 | B10 | `test/int/whl/backorders.int.spec.ts › splits an order into fulfilled and backordered parts` | getOrder, createFulfilment |
| FR-WHL-006 | B10 | `test/int/whl/credit-limit.int.spec.ts › blocks an order that would exceed the limit` | confirmOrder, getBusinessAccount |
| FR-WHL-007 | B10 | `test/int/whl/credit-override.int.spec.ts › approves audits and reports an override` | listCreditOverrides, approveRequest, getDailyExceptionReport |
| FR-WHL-008 | B10 | `test/int/whl/account-hold.int.spec.ts › places a hold the day an invoice passes the threshold` | holdBusinessAccount, releaseBusinessAccount, confirmOrder |
| FR-WHL-009 | B10 | `test/int/whl/statements.int.spec.ts › balances opening to closing exactly` | listStatements, createStatement, getStatement, sendStatement |
| FR-WHL-010 | B10 | `test/int/whl/ageing.int.spec.ts › buckets by days past due and ties to receivables` | getAgeingReport, listOpenItems |
| FR-WHL-011 | B10 | `test/int/whl/dunning.int.spec.ts › sends each level once per invoice` | listDunningLevels, replaceDunningLevels, listDunningNotices |
| FR-WHL-012 | B10 | `test/int/whl/bad-debt.int.spec.ts › writes off with approval and a journal` | writeOffBadDebt, approveRequest |
| SEC-014 | B13 | `test/e2e/whl/abuse-14-credit-override.e2e.spec.ts › blocks an order over the limit without approval`<br>`test/e2e/whl/abuse-14-credit-override.e2e.spec.ts › reports the override as CREDIT_OVERRIDE with abuse case 14` | confirmOrder, approveRequest, listCreditOverrides, getDailyExceptionReport |

#### QUO: Quotations and requests for quote

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-QUO-001 | B10 | `test/int/quo/rfq-public.int.spec.ts › accepts valid requests and rate limits abuse` | submitQuoteRequest |
| FR-QUO-002 | B10 | `test/int/quo/rfq-internal.int.spec.ts › links to an existing customer by phone` | listRfqs, createRfq, getRfq, updateRfq |
| FR-QUO-003 | B10 | `test/unit/quo/quote-totals.unit.spec.ts › computes totals tax and margin on the server` | listQuotes, createQuote, getQuote |
| FR-QUO-004 | B10 | `test/unit/quo/quote-validity.unit.spec.ts › expires at the end of the validity date` | issueQuoteVersion, getQuote |
| FR-QUO-005 | B10 | `test/int/quo/quote-margin-floor.int.spec.ts › needs approval below the floor` | issueQuoteVersion, approveRequest |
| FR-QUO-006 | B10 | `test/int/quo/quote-versions.int.spec.ts › keeps every issued version immutable` | listQuoteVersions, reviseQuote, updateQuoteVersion, issueQuoteVersion |
| FR-QUO-007 | B10 | `test/int/quo/quote-issue.int.spec.ts › archives the document and sends one message` | issueQuoteVersion, viewQuoteByLink |
| FR-QUO-008 | B10 | `test/int/quo/quote-acceptance.int.spec.ts › accepts once through a signed expiring link` | viewQuoteByLink, acceptQuoteByLink |
| FR-QUO-009 | B10 | `test/int/quo/quote-expiry.int.spec.ts › expires and releases reservations` | declineQuoteByLink, declineQuote, cancelQuote |
| FR-QUO-010 | B10 | `test/int/quo/quote-manual-acceptance.int.spec.ts › records acceptance with evidence` | recordQuoteAcceptance |
| FR-QUO-011 | B10 | `test/int/quo/quote-conversion.int.spec.ts › creates exactly one order that keeps the links` | convertQuote, getOrder, getBillingDocument |
| FR-QUO-012 | B10 | `test/int/quo/quote-reservation.int.spec.ts › reserves named stock for the validity` | issueQuoteVersion, listStockReservations |
| FR-QUO-013 | B10 | `test/int/quo/quote-pipeline.int.spec.ts › computes win rate by salesperson and product line` | getQuotePipeline, listMyQuotes |

#### SHP: Online store

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-SHP-001 | B7 (ADR-0026) | `test/contract/shp/shop-catalogue.contract.spec.ts › exposes only public fields` | listCatalogue, listShopCategories |
| FR-SHP-002 | B7 (ADR-0026) | `test/contract/shp/shop-product.contract.spec.ts › derives availability without exposing quantity` | getCatalogueProduct |
| FR-SHP-003 | B7 (ADR-0026) | `test/int/shp/cart.int.spec.ts › re-resolves prices and refuses request-to-buy products` | createCart, getCart, addCartLine, updateCartLine, removeCartLine |
| FR-SHP-004 | B7 (ADR-0026) | `test/int/shp/cart-promotions.int.spec.ts › applies stacking rules and one coupon` | applyCartCoupon, removeCartCoupon, validateCoupon |
| FR-SHP-005 | B7 (ADR-0026) | `test/int/shp/checkout-reservation.int.spec.ts › reserves all lines or none` | startCheckout, getCheckout |
| FR-SHP-006 | B7 (ADR-0026) | `test/int/shp/checkout-expiry.int.spec.ts › releases stock and handles a late payment` | getCheckout |
| FR-SHP-007 | B9a (ADR-0026) | `test/int/shp/checkout-catch-weight.int.spec.ts › shows estimate maximum and rule` | getCheckout, updateCheckout |
| FR-SHP-008 | B7 (ADR-0026) | `test/int/shp/checkout-delivery-fee.int.spec.ts › applies the zone fee or collection only` | quoteDelivery, updateCheckout |
| FR-SHP-009 | B11 | `test/int/shp/checkout-slot.int.spec.ts › books capacity inside the checkout` | listDeliverySlotOptions, updateCheckout |
| FR-SHP-010 | B9a (ADR-0026) | `test/int/shp/guest-checkout.int.spec.ts › tracks by token without exposing internals` | updateCheckout, trackOrder |
| FR-SHP-011 | B9a (ADR-0026) | `test/int/shp/online-order.int.spec.ts › re-prices before payment and confirms on cleared payment` | placeOrder, initiateMobileMoneyCharge, getOrder |
| FR-SHP-012 | B9a (ADR-0026) | `test/int/shp/customer-profile.int.spec.ts › manages only the caller's own data` | getMyProfile, updateMyProfile, listMyAddresses, createMyAddress, updateMyAddress, archiveMyAddress |
| FR-SHP-013 | B9a (ADR-0026) | `test/contract/shp/customer-order.contract.spec.ts › omits cost and variance fields` | listMyOrders, getMyOrder, reorderMyOrder, answerMyOrderConsent |
| FR-SHP-014 | B9a (ADR-0026) | `test/int/shp/customer-documents.int.spec.ts › serves only own documents by signed url` | listMyDocuments, downloadMyDocument |
| FR-SHP-015 | B11 (ADR-0026) | `test/int/shp/abandoned-cart.int.spec.ts › sends at most one reminder per cart` | createCart, getCart |
| NFR-004 | B13 | `lighthouse/storefront-lcp.json › lcp under 2500 ms on slow 3G` | - |
| NFR-005 | B13 | `lighthouse/catalogue-weight.json › listing transfer size under 300 KB` | - |
| NFR-013 | B13 | `playwright/axe-wcag22aa.spec.ts › no serious or critical axe violations on key screens` | - |
| NFR-014 | B13 | `playwright/matrix.spec.ts › key flows pass on the browser and 360 px matrix` | - |

#### ORD: Order management and fulfilment

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-ORD-001 | B9a | `test/int/ord/order-record.int.spec.ts › holds every channel in one record` | listOrders, createOrder, getOrder |
| FR-ORD-002 | B9a | `test/unit/ord/order-state-machine.unit.spec.ts › allows only the documented transitions` | listOrderHistory, getOrder, confirmOrder |
| FR-ORD-003 | B9a | `test/int/ord/order-line-pricing.int.spec.ts › requires a price source and an approval outside the band` | createOrder, approveRequest |
| FR-ORD-004 | B9a | `test/int/ord/serialised-line.int.spec.ts › names one animal with quantity one` | createOrder |
| FR-ORD-005 | B9a | `test/int/ord/order-confirm.int.spec.ts › reserves every line or stays placed` | confirmOrder |
| FR-ORD-006 | B9a | `test/int/ord/sale-posting.int.spec.ts › commits stock document payment and ledger together or none` | completeCounterSale, createOrder, confirmOrder |
| FR-ORD-007 | B9a | `test/int/ord/order-completion.int.spec.ts › requires a movement or an exception per line` | syncOfflineSales, getOrder |
| FR-ORD-008 | B11 | `test/int/ord/pick-list.int.spec.ts › creates a fulfilment from a confirmed order` | listFulfilments, createFulfilment, getFulfilment |
| FR-ORD-009 | B11 | `test/unit/ord/picked-line-total.unit.spec.ts › computes the total from weighed kilograms` | recordPicks |
| FR-ORD-010 | B11 | `test/int/ord/catch-weight-pick.int.spec.ts › enforces the tolerance and requires consent above it` | recordPicks, recordCustomerConsent, answerMyOrderConsent |
| FR-ORD-011 | B11 | `test/int/ord/dispatch.int.spec.ts › invoices the weighed quantity and settles the deposit` | packFulfilment, dispatchFulfilment, collectFulfilment, getBillingDocument |
| FR-ORD-012 | B11 | `test/int/ord/partial-fulfilment.int.spec.ts › bills only the fulfilled quantity` | createFulfilment, getOrder |
| FR-ORD-013 | B11 | `test/int/ord/substitution.int.spec.ts › needs recorded customer consent` | proposeSubstitution, recordCustomerConsent, answerMyOrderConsent |
| FR-ORD-014 | B11 | `test/int/ord/order-cancel.int.spec.ts › releases stock and requests a refund in one transaction` | cancelOrder, cancelFulfilment, requestRefund |
| FR-ORD-015 | B9a | `test/int/ord/order-return.int.spec.ts › cannot exceed the quantity sold` | createReturn, getReturn, submitReturn |
| FR-ORD-016 | B9a | `test/unit/ord/payment-status.unit.spec.ts › derives from allocations` | getOrder, listPayments |
| SEC-012 | B13 | `test/e2e/ord/abuse-12-false-return.e2e.spec.ts › refuses a return beyond what was sold`<br>`test/e2e/ord/abuse-12-false-return.e2e.spec.ts › reports the refund as REFUND with abuse case 12` | createReturn, requestRefund, approveRequest, getDailyExceptionReport |

#### DEL: Delivery and logistics

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-DEL-001 | B7 (table, generation), B11 (capacity) (ADR-0026) | `test/int/del/slot-capacity.int.spec.ts › never exceeds capacity under concurrent booking` | listDeliverySlots, generateDeliverySlots, updateDeliverySlot |
| FR-DEL-002 | B11 | `test/unit/del/cut-off.unit.spec.ts › picks the earliest slot after the cut-off` | listDeliverySlotOptions |
| FR-DEL-003 | B11 | `test/int/del/delivery-reschedule.int.spec.ts › moves a booking atomically` | listDeliveries, getDelivery, rescheduleDelivery, cancelDelivery |
| FR-DEL-004 | B11 | `test/int/del/delivery-assignment.int.spec.ts › limits a driver to their own deliveries` | assignDelivery, getMyDelivery |
| FR-DEL-005 | B11 | `test/int/del/route.int.spec.ts › orders stops and loads the vehicle` | listRoutes, createRoute, getRoute, reorderRouteStops, startRoute, getMyRoute |
| FR-DEL-006 | B11 | `test/int/del/driver-sync.int.spec.ts › applies each queued event exactly once` | syncDriverEvents, getMyRoute |
| FR-DEL-007 | B11 | `test/int/del/on-the-way.int.spec.ts › records the status once` | markOnTheWay |
| FR-DEL-008 | B11 | `test/int/del/proof-of-delivery.int.spec.ts › requires a recipient and a signature or photograph` | recordProofOfDelivery, getMyDelivery |
| FR-DEL-009 | B11 | `test/int/del/cod-collection.int.spec.ts › fixes the amount due and posts to the driver account` | recordProofOfDelivery, getMyCashSummary |
| FR-DEL-010 | B11 | `test/int/del/driver-reconciliation.int.spec.ts › posts the variance with a different user` | listDriverCashReconciliations, createDriverCashReconciliation, getDriverCashReconciliation, postDriverCashReconciliation, getDailyExceptionReport |
| FR-DEL-011 | B11 | `test/int/del/failed-delivery.int.spec.ts › reattempts or returns stock to the hold` | recordFailedDelivery, returnDeliveryToStock, rescheduleDelivery |
| FR-DEL-012 | B11 | `test/int/del/delivery-notifications.int.spec.ts › queues one message per event in the same transaction` | startRoute, markOnTheWay, recordProofOfDelivery |
| SEC-006 | B13 | `test/e2e/del/abuse-06-driver-cash.e2e.spec.ts › refuses a self-posted reconciliation and flags a changed amount`<br>`test/e2e/del/abuse-06-driver-cash.e2e.spec.ts › reports the variance as DRIVER_VARIANCE with abuse case 6` | recordProofOfDelivery, postDriverCashReconciliation, getDailyExceptionReport |

#### BIL: Invoicing, receipts and credit notes

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-BIL-001 | B8 | `test/int/bil/numbering-concurrency.int.spec.ts › issues gap-free numbers under concurrent load with rollbacks` | issueProforma, listBillingDocuments |
| FR-BIL-002 | B8 | `test/unit/bil/number-format.unit.spec.ts › formats prefix year branch register and sequence` | listNumberSeries, updateNumberSeries |
| FR-BIL-003 | B8 | `test/int/bil/numbering-audit.int.spec.ts › reports an orphan or gap without repairing` | listBillingDocuments, getHealth |
| FR-BIL-004 | B8 | `test/int/bil/document-tax-rows.int.spec.ts › snapshots every levy and balances line totals` | getBillingDocument |
| FR-BIL-005 | B8 | `test/unit/bil/weighed-billing.unit.spec.ts › bills picked weight not ordered quantity` | getBillingDocument, dispatchFulfilment |
| FR-BIL-006 | B8 | `test/int/bil/document-kinds.int.spec.ts › issues the right kind per sale type` | issueProforma, getBillingDocument, listBillingDocuments |
| FR-BIL-007 | B8 | `test/int/bil/credit-note.int.spec.ts › cannot exceed the uncredited amount` | issueCreditNote, issueDebitNote |
| FR-BIL-008 | B8 | `test/int/bil/document-archive.int.spec.ts › freezes an issued document` | getBillingDocument, listArchivedDocuments |
| FR-BIL-009 | B8 | `test/int/bil/reprint.int.spec.ts › returns the same document with a marker and no new number` | reprintBillingDocument, listBillingDocumentReprints |
| FR-BIL-010 | B8 | `test/int/bil/document-template-version.int.spec.ts › renders with the version used at issue` | reprintBillingDocument |
| FR-BIL-011 | B8 | `test/int/bil/offline-receipt-number.int.spec.ts › links provisional and official numbers` | syncOfflineSales, listBillingDocuments |
| FR-BIL-012 | B8 | `test/int/bil/certified-totals.int.spec.ts › stores optional certified totals beside line sums` | getBillingDocument |

#### PAY: Payments and reconciliation

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-PAY-001 | B9a | `test/int/pay/payment-capture.int.spec.ts › applies each method's clearing behaviour` | listPayments, recordPayment, getPayment |
| FR-PAY-002 | B9a | `test/int/pay/payment-freeze.int.spec.ts › refuses edits to a cleared payment` | getPayment |
| FR-PAY-003 | B9a | `test/int/pay/mobile-money-initiate.int.spec.ts › creates one provider charge per key` | initiateMobileMoneyCharge, checkPaymentStatus |
| FR-PAY-004 | B9a | `test/int/pay/webhook-verification.int.spec.ts › rejects bad signature stale timestamp replay and wrong amount` | receivePaymentWebhook |
| FR-PAY-005 | B9a | `test/int/pay/verified-clearing.int.spec.ts › accepts clearing only from provider verification` | recordPayment, checkPaymentStatus, listUnmatchedPayments |
| FR-PAY-006 | B9a | `test/int/pay/webhook-rejection-log.int.spec.ts › logs and reports every rejection` | receivePaymentWebhook, getDailyExceptionReport |
| FR-PAY-007 | B9a | `test/int/pay/payment-timeout-after-charge.int.spec.ts › clears once by lookup after a timeout` | initiateMobileMoneyCharge, checkPaymentStatus |
| FR-PAY-008 | B9a | `test/int/pay/webhook-edge-cases.int.spec.ts › applies once and holds an orphan payment` | receivePaymentWebhook, listUnmatchedPayments |
| FR-PAY-009 | B9a | `test/int/pay/payment-allocation.int.spec.ts › never exceeds payment or outstanding` | allocatePayment, unallocatePayment, listOpenItems |
| FR-PAY-010 | B9a | `test/int/pay/overpayment.int.spec.ts › holds the excess in deposits or suspense` | listPayments, listOpenItems, listUnmatchedPayments |
| FR-PAY-011 | B9a | `test/int/pay/cheque-clearing.int.spec.ts › clears or bounces and posts` | clearCheque, matchBankStatementLine |
| FR-PAY-012 | B9a | `test/int/pay/refund.int.spec.ts › limits to the unrefunded amount and approves above the limit` | listRefunds, requestRefund, getRefund, approveRequest |
| FR-PAY-013 | B9a | `test/int/pay/refund-failure.int.spec.ts › retries then queues a break` | retryRefund, markRefundPaid, listReconciliationBreaks |
| FR-PAY-014 | B9a | `test/int/pay/payment-reversal.int.spec.ts › posts the mirror journal with approval` | reversePayment, approveRequest |
| FR-PAY-015 | B9a | `test/int/pay/store-credit.int.spec.ts › cannot be redeemed beyond the balance` | getCustomerStoreCredit, getMyStoreCredit |
| FR-PAY-016 | B9a | `test/int/pay/settlement-matching.int.spec.ts › matches lines and raises a break for the rest` | listSettlementReports, importSettlementReport, getSettlementReport, matchSettlementReport, listBankStatements, importBankStatement, getBankStatement, matchBankStatement, matchBankStatementLine |
| FR-PAY-017 | B9a | `test/int/pay/reconciliation-breaks.int.spec.ts › records and resolves without auto-correction` | listReconciliationBreaks, getReconciliationBreak, resolveReconciliationBreak, getDailyExceptionReport |
| SEC-004 | B13 | `test/e2e/pay/abuse-04-forged-confirmation.e2e.spec.ts › refuses a cleared status without provider verification`<br>`test/e2e/pay/abuse-04-forged-confirmation.e2e.spec.ts › reports the unverified tender as UNMATCHED_PAYMENT with abuse case 4` | recordPayment, completeCounterSale, listUnmatchedPayments, getDailyExceptionReport |
| SEC-005 | B13 | `test/e2e/pay/abuse-05-forged-webhook.e2e.spec.ts › rejects forged stale replayed and wrong-amount webhooks`<br>`test/e2e/pay/abuse-05-forged-webhook.e2e.spec.ts › reports each rejection as WEBHOOK_REJECTED with abuse case 5` | receivePaymentWebhook, getDailyExceptionReport |
| SEC-030 | B9a | `test/contract/pay/no-card-data.contract.spec.ts › accepts no card fields and logs none` | initiateMobileMoneyCharge |

#### FIN: General ledger and accounting

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-FIN-001 | B8 | `test/int/fin/chart-of-accounts.int.spec.ts › seeds the accounts of ADR-0003` | listAccounts |
| FR-FIN-002 | B8 | `test/int/fin/accounts.int.spec.ts › refuses lines to a non-postable account` | listAccounts, createAccount, updateAccount |
| FR-FIN-003 | B8 | `test/int/fin/journal-balance.int.spec.ts › refuses an unbalanced entry at the database` | listJournalEntries, getJournalEntry |
| FR-FIN-004 | B8 | `test/int/fin/journal-immutability.int.spec.ts › refuses edits and enforces the subledger rule` | getJournalEntry, listAccountActivity |
| FR-FIN-005 | B8 | `test/int/fin/posting-rules.int.spec.ts › fails boot on an event without a complete rule` | listPostingEventTypes, listPostingRules, createPostingRule, listAccountDeterminations, createAccountDetermination |
| FR-FIN-006 | B8 | `test/int/fin/sale-journals.int.spec.ts › posts the sale cost and tender journals` | completeCounterSale, getJournalEntry, getTrialBalance |
| FR-FIN-007 | B8 | `test/int/fin/stock-journals.int.spec.ts › posts processing and write-off events` | getTrialBalance, completeProcessingOrder |
| FR-FIN-008 | B8 | `test/int/fin/manual-journal.int.spec.ts › posts only after a different user approves` | listManualJournals, createManualJournal, getManualJournal, updateManualJournal, submitManualJournal, approveRequest |
| FR-FIN-009 | B8 | `test/int/fin/accounting-periods.int.spec.ts › blocks posting into a closed period` | listAccountingPeriods, lockAccountingPeriod, closeAccountingPeriod |
| FR-FIN-010 | B8 | `test/int/fin/period-reopen.int.spec.ts › allows only the owner on a locked period` | reopenAccountingPeriod, closeAccountingPeriod |
| FR-FIN-011 | B8 | `test/int/fin/trial-balance.int.spec.ts › sums to zero over any date range` | getTrialBalance, listAccountActivity |
| FR-FIN-012 | B8 | `test/int/fin/financial-statements.int.spec.ts › tie to the trial balance` | getProfitAndLoss, getBalanceSheet |
| FR-FIN-013 | B8 | `test/int/fin/cash-flow.int.spec.ts › reconciles opening to closing cash` | getCashFlow |
| FR-FIN-014 | B8 | `test/int/fin/fixed-assets.int.spec.ts › records cost life and disposal` | listFixedAssets, createFixedAsset, getFixedAsset, updateFixedAsset, disposeFixedAsset |
| FR-FIN-015 | B8 | `test/unit/fin/depreciation.unit.spec.ts › spreads the depreciable amount exactly` | listDepreciationRuns, createDepreciationRun, getDepreciationRun, postDepreciationRun |
| FR-FIN-016 | B8 | `test/int/fin/ledger-reconciliation.int.spec.ts › reports drift and never corrects` | getTrialBalance, getHealth |

#### CAP: Capital, investors and profit sharing

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-CAP-001 | B12 | `test/int/cap/investor-register.int.spec.ts › numbers investors and archives only` | listInvestors, createInvestor, getInvestor, updateInvestor |
| FR-CAP-002 | B12 | `test/int/cap/investor-payout-details.int.spec.ts › encrypts payout details and isolates documents` | addInvestorDocument, listInvestorDocuments, updateInvestor |
| FR-CAP-003 | B12 | `test/int/cap/capital-contribution.int.spec.ts › issues units at the value date and posts to 3000` | recordCapitalTransaction, listCapitalTransactions, getCapitalTransaction, getCapitalRegister |
| FR-CAP-004 | B12 | `test/int/cap/capital-withdrawal.int.spec.ts › cannot exceed the holding and needs approval` | recordCapitalTransaction, approveRequest |
| FR-CAP-005 | B12 | `test/unit/cap/ownership-percent.unit.spec.ts › recomputes from the effective date` | getCapitalRegister, getInvestor |
| FR-CAP-006 | B12 | `test/unit/cap/distributable-profit.unit.spec.ts › applies the retention rate with half-up` | createDistributionRun, getDistributionRun |
| FR-CAP-007 | B12 | `test/unit/cap/unit-days.unit.spec.ts › counts the contribution day and not the withdrawal day` | recomputeDistributionRun |
| FR-CAP-008 | B12 | `test/unit/cap/distribution-allocation.unit.spec.ts › allocates an awkward amount without creating or losing a pesewa` | getDistributionRun, getDistributionSchedule |
| FR-CAP-009 | B12 | `test/unit/cap/distribution-allocation.unit.spec.ts › breaks a tie by investor number and refuses zero weights` | recomputeDistributionRun |
| FR-CAP-010 | B12 | `test/int/cap/distribution-approval.int.spec.ts › needs a different approver with step-up` | createDistributionRun, submitDistributionRun, postDistributionRun, getDistributionSchedule, approveRequest |
| FR-CAP-011 | B12 | `test/int/cap/distribution-posting.int.spec.ts › ties the run to the ledger exactly` | postDistributionRun, getTrialBalance |
| FR-CAP-012 | B12 | `test/int/cap/distribution-payment.int.spec.ts › cannot exceed net payable` | recordDistributionPayment, getDistributionRun |
| FR-CAP-013 | B12 | `test/int/cap/investor-statement.int.spec.ts › ties to the investor subledger` | getMyInvestorStatement, getInvestorReturns, listMyDistributions |
| FR-CAP-014 | B12 | `test/unit/cap/return-metrics.unit.spec.ts › computes roi payback and irr` | getInvestorReturns, getOverallReturns |
| FR-CAP-015 | B12 | `test/unit/cap/loan-interest.unit.spec.ts › accrues simple interest and applies repayments to interest first` | listFinancing, createFinancing, getFinancing, recordRepayment |

#### CST: Costing and profitability

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-CST-001 | B12 | `test/int/cst/cost-object.int.spec.ts › splits accumulated cost by element exactly` | getCostObject |
| FR-CST-002 | B12 | `test/int/cst/overhead-allocation.int.spec.ts › spreads the amount exactly and posts once` | listOverheadAllocations, createOverheadAllocation, getOverheadAllocation, postOverheadAllocation |
| FR-CST-003 | B12 | `test/int/cst/margins.int.spec.ts › compute margin by each dimension and tie out` | listMargins |
| FR-CST-004 | B12 | `test/int/cst/margin-projection.int.spec.ts › matches the ledger or reports drift` | listMargins |
| FR-CST-005 | B12 | `test/unit/cst/break-even.unit.spec.ts › rounds units up and handles non-positive contribution` | getBreakEven |
| FR-CST-006 | B12 | `test/int/cst/contribution-view.int.spec.ts › ties to margins and break-even` | getBreakEven, listMargins |
| FR-CST-007 | B12 | `test/int/cst/losses.int.spec.ts › reports shrinkage mortality and wastage apart from cost of sales` | listLosses |
| FR-CST-008 | B12 | `test/int/cst/costing-rebuild.int.spec.ts › rebuilds projections to identical figures` | getCostObject, listMargins |

#### RPT: Reporting and dashboards

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-RPT-001 | B12 | `test/int/rpt/owner-dashboard.int.spec.ts › ties each tile to its module of record` | getOwnerDashboard |
| FR-RPT-002 | B12 | `test/int/rpt/operational-reports.int.spec.ts › compute mortality feed and delivery measures` | listReportDefinitions, runReport, getReportRun |
| FR-RPT-003 | B12 | `test/int/rpt/daily-sales.int.spec.ts › groups reconcile to the day's total` | getDailySales |
| FR-RPT-004 | B12 | `test/int/rpt/report-runs.int.spec.ts › records every run and cancels slow queries` | listReportDefinitions, runReport, listReportRuns, getReportRun |
| FR-RPT-005 | B12 | `test/int/rpt/report-export.int.spec.ts › audits rows and demands step-up above 100` | runReport, getReportRun |
| FR-RPT-006 | B12 | `test/int/rpt/report-schedule.int.spec.ts › delivers once per occurrence` | listReportSchedules, createReportSchedule, updateReportSchedule |
| FR-RPT-007 | B12 (ADR-0026) | `test/int/rpt/exception-report.int.spec.ts › covers every abuse case through its kind` | getDailyExceptionReport, listExceptions |
| FR-RPT-008 | B12 (ADR-0026) | `test/int/rpt/detection-rates.int.spec.ts › computes rates by user and approval pairs` | getDailyExceptionReport |
| FR-RPT-009 | B12 | `test/int/rpt/read-model.int.spec.ts › isolates heavy reports from the transactional tables` | runReport, getHealth |
| FR-RPT-010 | B12 | `test/int/rpt/projection-drift.int.spec.ts › detects and reports a difference` | getHealth |
| SEC-009 | B13 | `test/e2e/rpt/abuse-09-bulk-export.e2e.spec.ts › refuses a bulk export without step-up`<br>`test/e2e/rpt/abuse-09-bulk-export.e2e.spec.ts › reports the export as BULK_EXPORT with abuse case 9` | createExportJob, runReport, getDailyExceptionReport |

#### NTF: Notifications

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-NTF-001 | B11 | `test/int/ntf/notification-templates.int.spec.ts › versions and validates merge fields` | listNotificationTemplates, createNotificationTemplate, getNotificationTemplate, activateNotificationTemplate, previewNotificationTemplate |
| FR-NTF-002 | B11 | `test/int/ntf/notification-triggers.int.spec.ts › enables and disables by event` | listNotificationTriggers, updateNotificationTrigger |
| FR-NTF-003 | B11 | `test/int/ntf/notification-idempotency.int.spec.ts › sends once per event and recipient` | listNotificationMessages, getNotificationMessage |
| FR-NTF-004 | B11 | `test/int/ntf/channel-preferences.int.spec.ts › falls back in order` | getMyNotificationPreferences, replaceMyNotificationPreferences |
| FR-NTF-005 | B11 | `test/int/ntf/opt-out.int.spec.ts › suppresses reminders and keeps transactional receipts` | listOptOuts, receiveMessagingWebhook |
| FR-NTF-006 | B11 | `test/unit/ntf/quiet-hours.unit.spec.ts › delays non-urgent messages to 07:00` | listNotificationMessages |
| FR-NTF-007 | B11 | `test/int/ntf/notification-delivery.int.spec.ts › retries and records provider receipts` | listNotificationMessages, getNotificationMessage, retryNotificationMessage, receiveMessagingWebhook |
| FR-NTF-008 | B11 | `test/int/ntf/in-app-notifications.int.spec.ts › keeps per-recipient read state` | listMyNotifications, markNotificationRead |

#### DOC: Documents and media

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-DOC-001 | B8 | `test/int/doc/document-archive.int.spec.ts › stores bytes with a hash and refuses change` | listArchivedDocuments, getArchivedDocument |
| FR-DOC-002 | B8 | `test/int/doc/archive-completeness.int.spec.ts › archives every issued document kind` | listArchivedDocuments |
| FR-DOC-003 | B8 | `test/int/doc/document-render.int.spec.ts › completes the sale and renders later` | getBillingDocument, getArchivedDocument |
| FR-DOC-004 | B8 | `test/int/doc/document-templates.int.spec.ts › versions renders in a sandbox and keeps issued documents unchanged` | listDocumentTemplates, getDocumentTemplate, listTemplateVersions, createTemplateVersion, getTemplateVersion, activateTemplateVersion, previewTemplateVersion |
| FR-DOC-005 | B4 | `test/int/doc/image-variants.int.spec.ts › produces compressed variants and hides the original` | addProductImage, uploadFile |
| FR-DOC-006 | B3 | `test/int/doc/upload-pipeline.int.spec.ts › sniffs caps scans and serves only clean files` | uploadFile, getFile |
| FR-DOC-007 | B3 | `test/int/doc/signed-urls.int.spec.ts › expire and log each issue` | createFileSignedUrl, downloadArchivedDocument, downloadMyDocument |
| SEC-027 | B3 | `test/int/doc/upload-safety.int.spec.ts › sniffs caps scans and serves only clean files` | uploadFile, getFile |

#### AUD: Audit, compliance and administration

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-AUD-001 | B3 | `test/int/aud/audit-events.int.spec.ts › commits an audited change and its event together` | listAuditEvents, getAuditEvent, updateProduct |
| FR-AUD-002 | B3 | `test/int/aud/audit-append-only.int.spec.ts › refuses update delete and truncate` | getAuditIntegrity |
| FR-AUD-003 | B3 | `test/int/aud/audit-chain.int.spec.ts › links each event to its predecessor by hash` | getAuditIntegrity |
| FR-AUD-004 | B3 | `test/int/aud/audit-verification.int.spec.ts › detects a rewritten chain against the anchor` | getAuditIntegrity, getDailyExceptionReport |
| FR-AUD-005 | B3 | `test/int/aud/audit-read-access.int.spec.ts › limits the log to owner and accountant` | listAuditEvents, getAuditEvent |
| FR-AUD-006 | B3 | `test/int/aud/audit-payload.int.spec.ts › excludes secrets and encrypts personal data per subject` | getAuditEvent, getAuditIntegrity |
| FR-AUD-007 | B3 | `test/int/aud/settings.int.spec.ts › validates audits and applies a change without deployment` | listSettings, updateSetting |
| FR-AUD-008 | B3 | `test/int/aud/administration.int.spec.ts › edits prefix and profile but not the sequence value` | listNumberSeries, updateNumberSeries, getBusinessProfile, updateBusinessProfile |
| FR-AUD-009 | B13 (ADR-0026) | `test/int/aud/retention.int.spec.ts › applies the policy without touching statutory documents` | listRetentionPolicies, updateRetentionPolicy |
| FR-AUD-010 | B13 (ADR-0026) | `test/int/aud/data-export-request.int.spec.ts › verifies identity and releases only the subject's data` | listDataSubjectRequests, createDataSubjectRequest, getDataSubjectRequest, verifyDataSubjectIdentity, processDataSubjectRequest, rejectDataSubjectRequest, createMyDataRequest |
| FR-AUD-011 | B13 (ADR-0026) | `test/int/aud/data-deletion.int.spec.ts › destroys the subject key and keeps statutory documents` | processDataSubjectRequest, rejectDataSubjectRequest, approveRequest |
| FR-AUD-012 | B13 | `test/smoke/aud/restore-drill.smoke.spec.ts › restores last night's backup and reproduces the trial balance` | getTrialBalance, getAuditIntegrity |
| FR-AUD-013 | B3 | `test/int/aud/health.int.spec.ts › reports sealing lag backlog and reconciliation outcomes` | getHealth |
| SEC-015 | B13 | `test/e2e/aud/abuse-15-ledger-tamper.e2e.spec.ts › refuses direct changes and detects a rewrite`<br>`test/e2e/aud/abuse-15-ledger-tamper.e2e.spec.ts › reports tampering as AUDIT_INTEGRITY and RECONCILIATION_BREAK with abuse case 15` | getAuditIntegrity, getTrialBalance, getDailyExceptionReport |
| SEC-028 | B3 | `test/contract/aud/classification.contract.spec.ts › exposes no internal or restricted field publicly` | listCatalogue, getSupplierProfile |
| SEC-029 | B13 | `test/smoke/aud/tls-and-encryption.smoke.spec.ts › refuses tls 1.2 and stores restricted fields encrypted` | getHealth |
| SEC-032 | B3 | `test/int/aud/audit-tamper.int.spec.ts › detects a changed byte and refuses update` | getAuditIntegrity |
| SEC-033 | B13 | `test/smoke/aud/incident-response.smoke.spec.ts › follows the runbook and preserves evidence` | getAuditIntegrity |
| SEC-037 | B13 | `test/smoke/aud/compliance.smoke.spec.ts › holds a dated source for each obligation` | getBusinessProfile |

#### API: Integrations

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| FR-API-001 | B2 | `test/contract/api/versioning.contract.spec.ts › fails on an unversioned breaking change` | getHealth |
| FR-API-002 | B2 | `test/contract/api/openapi-drift.contract.spec.ts › fails when the generated contract differs from the committed one` | getHealth |
| FR-API-003 | B3 | `test/contract/api/conventions.contract.spec.ts › applies the envelope pagination and money naming everywhere` | listProducts, listStockOnHand |
| FR-API-004 | B3 | `test/int/api/idempotency.int.spec.ts › returns the first result for a replay and 409 for a changed body` | createOrder, recordPayment, receivePaymentWebhook |
| FR-API-005 | B3 | `test/int/api/outbox.int.spec.ts › writes side effects atomically with the change` | listNotificationMessages, listWebhookDeliveries |
| FR-API-006 | B3 | `test/int/api/outbox-dispatch.int.spec.ts › retries then dead-letters and stays visible` | getHealth, listWebhookDeliveries |
| FR-API-007 | B12 | `test/int/api/api-keys.int.spec.ts › scopes rotates and rate limits per key` | listIntegrations, createIntegration, getIntegration, updateIntegration, suspendIntegration, resumeIntegration, listApiCredentials, createApiCredential, rotateApiCredential, revokeApiCredential |
| FR-API-008 | B12 | `test/int/api/webhook-signing.int.spec.ts › signs each delivery with the endpoint secret` | listEventTypes, listWebhookEndpoints, createWebhookEndpoint, updateWebhookEndpoint, testWebhookEndpoint |
| FR-API-009 | B12 | `test/int/api/webhook-retry.int.spec.ts › backs off dead-letters and allows redelivery` | listWebhookDeliveries, redeliverWebhook |
| FR-API-010 | B12 | `test/int/api/webhook-url.int.spec.ts › refuses non-https and internal addresses` | createWebhookEndpoint, updateWebhookEndpoint |
| FR-API-011 | B3 | `test/unit/api/adapter-ports.unit.spec.ts › keeps domain code free of adapter imports` | initiateMobileMoneyCharge, createAccountingExport |
| FR-API-012 | B12 | `test/int/api/accounting-export.int.spec.ts › exports balanced journals idempotently` | listAccountingExports, createAccountingExport |
| FR-API-013 | B3 | `test/int/api/external-call-policy.int.spec.ts › applies timeout retry and breaker with a defined fallback` | initiateMobileMoneyCharge, completeCounterSale |
| FR-API-014 | B3 | `test/smoke/api/health.smoke.spec.ts › reports dependency status and names a failing item` | getHealth |
| SEC-023 | B3 | `test/int/api/input-validation.int.spec.ts › rejects unknown fields and wrong types on every route` | createProduct, createOrder |
| SEC-024 | B3 | `test/int/api/sql-safety.int.spec.ts › resists injection and holds no ddl privilege` | listProducts |
| SEC-025 | B3 | `test/int/api/browser-protections.int.spec.ts › enforces csrf cors cookies and security headers` | getCurrentSession, createOrder |
| SEC-026 | B3 | `test/int/api/rate-limits.int.spec.ts › limits per address account and key and fails closed on login` | loginStaff, submitQuoteRequest, startCheckout |
| SEC-031 | B3 | `test/unit/api/log-scrubbing.unit.spec.ts › removes secrets and masks phone numbers and payment ids` | loginStaff |

#### PLT: Platform and cross-cutting

| Id | Session | Proving test | Operations |
| --- | --- | --- | --- |
| SEC-034 | B2 | `test/smoke/plt/ci-security-gates.smoke.spec.ts › fails a pull request with a high-severity finding` | - |
| SEC-035 | B13 | `test/smoke/plt/sbom.smoke.spec.ts › generates a software bill of materials per release` | - |
| SEC-036 | B2 | `test/int/plt/database-roles.int.spec.ts › grants only the privileges each role needs` | getHealth |
| NFR-001 | B13 | `k6/api-read-latency.js › p95 under 300 ms at 50 virtual users` | - |
| NFR-002 | B13 | `k6/api-write-latency.js › p95 under 600 ms at 50 virtual users` | - |
| NFR-006 | B13 | `monitor/availability-monthly › 99.5 percent of minutes up` | - |
| NFR-007 | B13 | `drill/restore-rpo › restored data is at most 15 minutes behind the failure` | - |
| NFR-008 | B13 | `drill/restore-rto › full restore into a clean environment in under 4 hours` | - |
| NFR-009 | B13 | `drill/backup-monthly › latest backup restores and 30 days exist` | - |
| NFR-011 | B13 | `k6/seed-capacity.js › targets hold on a dataset of 10,000 products 150,000 orders and 2,000,000 movements` | - |
| NFR-012 | B13 | `k6/concurrency-mixed.js › 50 staff and 500 shop sessions meet the latency targets` | - |
| NFR-015 | B2 | `ci/coverage-gate › thresholds 80 overall and 100 branch on the four modules` | - |
| NFR-016 | B2 | `ci/pipeline-timing › full pipeline under 12 minutes` | - |
| NFR-017 | B2 | `ci/fresh-clone › setup script brings the stack up on a clean checkout` | - |
| NFR-018 | B2 | `ci/import-boundaries › build fails on a cross-module internal import` | - |
| NFR-019 | B3 | `test/int/platform/correlation-id.int.spec.ts › one id appears in the response the log and the trace` | - |
| NFR-020 | B13 | `ci/runbook-coverage › every named failure mode has a runbook file` | - |
| NFR-021 | B2 | `ci/portability › the stack starts with only S3-compatible storage and no vendor service` | - |
| NFR-022 | B2 | `ci/i18n-lint › no hard-coded user-facing string in API messages or templates` | - |
| NFR-023 | B13 | `test/contract/platform/low-bandwidth.contract.spec.ts › every list is paginated and every screen endpoint returns a complete view` | - |
| NFR-024 | B13 | `review/cost-estimate › estimate under 150 USD a month at the NFR-011 capacity` | - |

### 7.3 Counts per module

| Module | FR | SEC | NFR | Total |
| --- | --- | --- | --- | --- |
| IAM | 22 | 6 | 0 | 28 |
| MDM | 21 | 0 | 0 | 21 |
| LIV | 17 | 1 | 0 | 18 |
| INV | 25 | 2 | 0 | 27 |
| PRC | 11 | 1 | 0 | 12 |
| PUR | 15 | 1 | 0 | 16 |
| POS | 22 | 4 | 2 | 28 |
| WHL | 12 | 1 | 0 | 13 |
| QUO | 13 | 0 | 0 | 13 |
| SHP | 15 | 0 | 4 | 19 |
| ORD | 16 | 1 | 0 | 17 |
| DEL | 12 | 1 | 0 | 13 |
| BIL | 12 | 0 | 0 | 12 |
| PAY | 17 | 3 | 0 | 20 |
| FIN | 16 | 0 | 0 | 16 |
| CAP | 15 | 0 | 0 | 15 |
| CST | 8 | 0 | 0 | 8 |
| RPT | 10 | 1 | 0 | 11 |
| NTF | 8 | 0 | 0 | 8 |
| DOC | 7 | 1 | 0 | 8 |
| AUD | 13 | 6 | 0 | 19 |
| API | 14 | 5 | 0 | 19 |
| PLT | 0 | 3 | 18 | 21 |
| **Total** | **321** | **37** | **24** | **382** |

### 7.4 Assumptions introduced by this document

These fill gaps the shared brief and the existing documents leave open. Each is a setting or a definition, so changing it changes data, not code. They are listed here so that `docs/ASSUMPTIONS.md` can record them; the owner or accountant named confirms each.

| Id | Assumption | Used by | Confirm |
| --- | --- | --- | --- |
| SA-01 | Login lockout after 5 consecutive failures; lock 1 minute, doubling per further failure, capped at 60 minutes | FR-IAM-017 | Owner |
| SA-02 | A bulk export is more than 1,000 rows and needs step-up (as the contract's `rpt.report.export.bulk` permission states) | FR-MDM-020, FR-RPT-005, SEC-009 | Owner |
| SA-03 | Webhook timestamp window of 5 minutes either side | FR-PAY-004, SEC-005 | Backend lead |
| SA-04 | Signed URLs for private files live 15 minutes for confidential files and 5 minutes for restricted ones (`docs/security/DATA_CLASSIFICATION.md`, A-050) | FR-DOC-007 | Backend lead |
| SA-05 | An account goes on hold when any invoice is more than 30 days past due | FR-WHL-008 | Owner |
| SA-06 | Quote validity 14 days; margin floor 10 percent over cost | FR-QUO-004, FR-QUO-005 | Owner |
| SA-07 | Yield variance flag when actual differs from expected by more than 5 percent of expected | FR-PRC-005 | Owner |
| SA-08 | Three-way match tolerance: price 1 percent, quantity zero beyond the receipt | FR-PUR-009 | Accountant |
| SA-09 | Quiet hours 21:00 to 07:00 Africa/Accra; security codes and delivery-day messages exempt | FR-NTF-006 | Owner |
| SA-10 | Webhook delivery: 8 attempts, exponential backoff from 1 minute with jitter, capped at 6 hours | FR-API-009 | Backend lead |
| SA-11 | Upload caps: images 5 MB; PDF and spreadsheets 10 MB | FR-DOC-006 | Backend lead |
| SA-12 | Default page size 25, maximum 100, as the contract's `PageLimit` | FR-API-003 | Backend lead |
| SA-13 | Delivery zones and fees are master data in B4 (FR-MDM-010); slot capacity and scheduling stay in B11; B7's checkout accepts a slot without enforcing capacity; F7 builds the picker against the mock. Confirmed 2026-11-13 | FR-SHP-008, FR-SHP-009 | Owner |
| SA-14 | IRR uses the investor's share of total equity at the as-at date as closing value, actual/365; ROI is distributions paid over net contributions | FR-CAP-014 | Accountant |
| SA-15 | Seed rate limits: login 10 per minute per address and per account; password reset 5 per hour per account; quote request 5 per hour per address and per phone; checkout 10 per minute per address; API key 60 per minute unless set. All are settings recorded in `docs/OPERATIONS.md` (SECURITY_ARCHITECTURE section 5) | SEC-026, FR-QUO-001, FR-SHP-010, FR-API-007 | Backend lead |
| SA-16 | Application and security logs are kept 365 days | SEC-033 | Owner |
| SA-17 | Exception report thresholds: a price-override item once a user reaches 80 percent of the shift limit; an unverified tender pending 15 minutes; a handler's mortality rate over twice the pen average in 30 days; refunds in a day over 3 times the branch average; 1,000 exported rows in a day; an adjustment within 7 days before a stock take of the location; 5 authorisation refusals by one principal in an hour; a supplier payment within 24 hours after a payout detail change | SEC-002, SEC-003, SEC-004, SEC-007, SEC-008, SEC-009, SEC-012, SEC-013 | Owner |
| SA-18 | Retention and subject-request seeds: notification bodies 12 months, carts and expired checkouts 30 days (as A-050), subject export within 30 days; statutory documents follow A-063 | FR-AUD-009, FR-AUD-010 | Owner, after the compliance check |
| SA-19 | Operational seeds: expiring-stock alert 3 days before expiry; storefront availability `LOW` at 5 or fewer; gestation days goat 150, sheep 147, pig 114, rabbit 31 | FR-INV-016, FR-SHP-002, FR-LIV-010 | Owner and vet |
| SA-20 | Customer phone verification: 6-digit code, 10 minutes, 5 attempts; password reset token 30 minutes; password minimum 12 characters | FR-IAM-005, FR-IAM-019, FR-IAM-020 | Backend lead |
| SA-21 | Definitions where the brief is silent: credit exposure is outstanding invoiced balance plus confirmed uninvoiced orders; ageing buckets are days past due (Current, 1 to 30, 31 to 60, 61 to 90, over 90); mortality rate is deaths per 1,000 head-days; average daily gain and feed conversion as in FR-LIV-005 and FR-LIV-016; in a tax-inclusive split the leftover pesewa goes to net first and then to levies in calculation order | FR-WHL-006, FR-WHL-010, FR-RPT-002, FR-MDM-014 | Accountant |

### 7.5 Where the matrix is checked

A script in B2 reads this file and `contract/openapi.yaml` and fails the build if a requirement id in the matrix does not exist in section 4, 5 or 6, if an operationId in the matrix is not in the contract, or if a test named in the matrix does not exist once its module is built. Until a module is built, the matrix names the test the module's session must create under exactly that name.
