# B01 — Documents, skills and the contract

Date: 2026-11-13 · Status: gate passed for the frontend's dependency: the contract covers every screen the frontend has planned. Owner review of the documents is open.

**The frontend is unblocked.** `contract/openapi.yaml` version 1.1.0 is on `b01-documents-contract` at `backend/contract/openapi.yaml`, where `frontend/scripts/sync-contract.sh` reads it.

## Contract changes

Version 1.1.0 (three versions this session, all in `docs/CONTRACT_CHANGELOG.md`):

- **1.0.0:** first contract. 600 operations on 476 paths, 809 schemas, every module in the brief including those built in B12.
- **1.0.1:** corrected examples only.
  - Catch-weight prices are per kilogram.
  - Quote delivery levies are added.
  - Animal price bands follow the weight band.
  - Processed animals no longer appear alive.
  - Royal Palm Hotel's ageing is consistent with its account.
  - The abuse-case mapping on the exception report is fixed.
  - The unit price default is GHS 100.00.
- **1.1.0:** additive fields for the POS offline queue and opening stock.
  - An unverified offline mobile money tender.
  - The last device counter at shift close.
  - Per-cash-movement sync results, and a cap of 500 sales per batch.
  - A driver sync outcome for exceptions.
  - `OPENING` goods receipts.
  - Two new exception kinds.

No breaking change since 1.0.0.

How it was built and checked:

- **Builder:** written by hand through a builder kept in the scratchpad, not committed. From B2 the contract is generated from code, so later changes are made in code.
- **Examples:**
  - Every request and response example validates against its schema.
  - Every list example has at least five rows from one seeded farm.
  - Counter sale, tax, processing cost and distribution figures come from the same largest-remainder rule the backend will use.
- **YAML:** an independent PyYAML parse equals the builder's output.
- **Lint:** `npx @redocly/cli lint contract/openapi.yaml` passes with no errors and no warnings. The localhost-server rule is turned off in `redocly.yaml`, with the reason given there.
- **Not run:** a Prism mock server. Starting it was refused by the permission classifier (see Notes for the frontend track).
- **Conventions:** ADR-0029.
  - Money is integer `...Pesewas` fields with `currency` on the object.
  - Decimals are strings.
  - One error envelope.
  - 202 `ApprovalPending` for maker-checker.

## Built

| Area | Files |
| --- | --- |
| Contract | `contract/openapi.yaml`, `redocly.yaml`, `docs/CONTRACT_CHANGELOG.md`, `docs/API.md` |
| Requirements | `docs/SRS.md`: 321 functional, 37 security and 24 non-functional requirements, each with actor, trigger, rule, outcome and acceptance, and a traceability matrix to module, session, test and operation |
| Security and compliance | `docs/security/DATA_CLASSIFICATION.md`, `SECURE_CODING_STANDARDS.md` (24 rules, each with correct and incorrect examples), `COMPLIANCE.md` (sources checked 2026-11-13, each with a status) |
| Standards | `docs/ENGINEERING_STANDARDS.md`, `docs/TEST_STRATEGY.md` |
| Offline and operations | `docs/OFFLINE_SYNC.md` (nine worked examples), `docs/OPERATIONS.md` (about 110 environment variables, alert thresholds, cost estimate), `docs/DEPLOYMENT.md`, `docs/DATA_MIGRATION.md`, nine runbooks in `docs/runbooks/` |
| For people | `docs/UAT.md` (the seven scenarios for the owner), `docs/GLOSSARY.md` (about 150 terms), `docs/ONBOARDING.md`, `docs/README.md` (index and reading order) |
| Build prompts | `docs/prompts/README.md`, `session-openers.md` (B2 to B13, including B9a and B9b), `module-build-prompt.md`, `SKILLS_VERIFICATION.md` |
| Claude Code | `CLAUDE.md` (82 lines); 16 skills in `.claude/skills/` |

The documents except the contract were written by five agents working in parallel from a common brief. I reviewed each set against the B0 documents before committing, and fixed or recorded every inconsistency they reported.

## Decisions

Your three gate notes:

| Note | Where it is met |
| --- | --- |
| Tax confirmed against the VAT Act 2025 regime; two open points for the accountant | ADR-0020 status Accepted; `COMPLIANCE.md` section 3 records your decision of 2026-11-13; ASSUMPTIONS A-033 (GHS 750,000 threshold) and A-034 (imported inputs cascading), each answered as data. GRA's Act 1151 guideline (GRA/AG/25/002) corroborates the rates; the Act itself could not be read online |
| Run the Redocly lint, and say so if it is refused | It ran and passed; it was not refused |
| B13 must confirm every abuse case lands on the daily exception report | `docs/BUILD_PROMPT.md` B13 section amended; THREAT_MODEL section 4 maps every case to an exception kind; `ExceptionItem.abuseCases` in the contract; SRS SEC-001 to SEC-018 each require two tests; UAT scenario 5 checks both |

Other decisions made this session:

- **Money shape (ADR-0029).** Integer `...Pesewas` fields, with cost and price never sharing a field. This answers the frontend's CR-001 in full, except that enum values are upper case (`WEIGHTED_AVERAGE`). ADR-0001 and ARCHITECTURE amended to match.
- **Cookie names carry the realm:** `__Host-hk_s_at`, `_c_at` and `_i_at`, with matching `_rt` refresh cookies (ADR-0016 amended).
- **Billing settlement summary:** a new projection, `bil.document_settlement`, so an invoice screen needs one request. BIL keeps it from payment events; PAY stays the figure of record.
- **Three exception kinds added** so every abuse case lands on the report: `PAYOUT_DETAIL_CHANGE`, `PERMISSION_CHANGE`, `YIELD_VARIANCE`. Two more for offline: `SYNC_REJECTED`, `LATE_POSTING`.
- **Levy tie-break:** the leftover pesewa of a tax-inclusive split goes to net first, then to the levies in calculation order (ADR-0020).
- **Idempotency exceptions listed (ADR-0014):** batch syncs, logins, webhooks, and POSTs that change nothing.
- **Unit price default:** GHS 100.00 per unit (A-031 changed).

## Assumptions

All are dated in `docs/ASSUMPTIONS.md`. New this session:

- **Settings and definitions from the SRS:** SA-01 to SA-21, such as lockout, rate limits, exception-report thresholds and ageing definitions.
- **Design gaps the compliance check found:**
  - A-035: customers who withhold VAT.
  - A-036: personal data in clear in insert-only tables, which a deletion request cannot erase. **Needs an ADR in B3.**
  - A-037: restoring a backup brings back destroyed subject keys.
  - A-038: the cashier PIN has no stored verifier.
  - A-039: E-VAT certification does not fit the issuing transaction or offline receipts. **Needs an ADR before B8 if the business is registered.**
- **Defaults and rules:**
  - A-050: non-statutory retention defaults.
  - A-051 to A-055: from the UAT. They cover deposits and credit, the delivery fee on partial dispatch, no self-granted roles, drill tooling for non-developers, and the UAT seed baseline.
  - A-056 to A-059: from operations and data migration. They cover the restore drill in an isolated database, the extra containers (malware scanner from B3), the late-posting flag, and opening balances.

Compliance results to know (from `COMPLIANCE.md`):

- **A-061, provisional offline receipts:** no source confirms them. GRA guidance talks about notifying it within 24 hours and uploading offline transactions afterwards.
- **A-062, E-VAT:** applies if the business is registered.
- **A-063, retention against deletion requests:** supported by Act 843. Tax records are kept for at least six years; the policy is 84 months.

## Deferred

- **Fresh-session skill test:** Run 2 of `docs/prompts/SKILLS_VERIFICATION.md`. A session cannot restart itself, so it is scheduled as the first step of B2. Run 1, a blind description test, passed: the expected skill loaded for 32 of 32 tasks, and was the first skill on 30.
- **Error codes marked "Added" in `docs/API.md`:** adopted by the contract when B2 generates it.
- **Paystack details:** the webhook timestamp window and source addresses are unverified (A-064, B9a).
- **Delivery slot picker:** arrives in B11. Until then checkout offers zone and fee only (SA-13).
- **ADR status lines:** ADRs other than 0020, 0026 (in part) and 0028 still read "Proposed (awaiting B0 gate)". I have not marked them Accepted, because merging PR 1 is the recorded approval.

## Tests

None: documents and contract only. Checks run:

- Every contract example validated against its schema.
- The Redocly lint is clean.
- The YAML parses identically to the builder's output.
- No placeholder text in any document.
- Every relative link resolves.
- The skill descriptions were tested blind on 32 tasks.

## Gate

**The contract covers every screen the frontend has planned: passed.** The table below shows each frontend slot's screens against the contract.

| Frontend slot | Screens | Contract tags (operations) |
| --- | --- | --- |
| F1, F3 | App shells, login, users, roles, permissions | auth (15), iam (29), aud (18) |
| F4 | Catalogue admin, price lists, grades, bands | mdm (66), pricing (22), tax (10) |
| F5 | Stock, goods receipt, transfers, stock take | inv (49), including CR-001's stock-on-hand shape |
| F6 | Animal register, health, breeding, processing | liv (32), prc (15) |
| F7 | Storefront catalogue, cart, checkout | shp (30) |
| F8 | Invoices, receipts, statements, documents | bil (8), doc (10), whl statements |
| F9 | POS, offline queue, shifts | pos (22), pay (30) |
| F10 | Quote builder, public request for quote, wholesale | quo (21), whl (24) |
| F11 | Order tracking, driver view, proof of delivery | ord (21), del (25) |
| F12 | Dashboards, reports, investor portal | rpt (11), cst (8), cap (24), investor (6) |
| All | Notifications, integrations, files, health | ntf (16), api (15), platform (4) |

The frontend's one open contract request, CR-001, is implemented.

For you, before or at the start of B2:

1. Merge PR 1, which approves B0, then this session's pull request. The B1 branch is stacked on B0's.
2. Confirm or change the three proposed schedule assignments in ADR-0026 (A-040). Your gate notes did not mention them, so B1 used them as proposed.
3. Send the accountant A-033, A-034, A-035 and A-039.

## Notes for the frontend track

- **Contract:** 1.1.0. Run `./scripts/sync-contract.sh`, then `npx @stoplight/prism-cli mock contract/openapi.yaml --port 4010`. I could not start Prism here, because the permission classifier refused it; please confirm the mock serves examples before F2 relies on it.
- **CR-001:** done. Use `GET /stock/on-hand` for `unitCostPesewas`, `valueAtCostPesewas`, `valuationMethod`, `priceBand` (price, separate), `totalValueAtCostPesewas` and `asOf`. Enum values are upper case.
- **Money:** every money field is an integer named `...Pesewas`, with `currency` on the object, which fits `formatMoney(pesewas)`. Weights are strings with three decimals.
- **Cookies:** realm-specific; send `X-CSRF-Token` from `GET /auth/session`. Exact token lifetimes arrive with B3's report.
- **Customer views:** use `CustomerOrder` and the `/me/*` operations, never staff `SalesOrder`, which carries floors, ceilings and variance.
- **Offline:** offline sales use the 1.1.0 fields. The rules are in `docs/OFFLINE_SYNC.md`; tenders are cash only unless the setting allows otherwise.
- **Delivery slots:** the slot picker has endpoints, but the backend builds them in B11.

## Next session

B02 — Foundation. Open it with the message in `docs/prompts/session-openers.md`, section "B2 — Foundation", which begins:

"Read CLAUDE.md, docs/SHARED_BRIEF.md and the B2 section of docs/BUILD_PROMPT.md. List docs/sessions/ and read only the most recent report (B01's)." It continues with Run 2 of the skill check, then the foundation, including the advisory-lock test (A-060), and stops at the gate: one-command setup on a clean machine, CI green.
