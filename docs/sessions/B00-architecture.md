# B00 — Architecture and design

Date: 2026-11-13 · Status: gate pending, awaiting the owner's approval of the architecture and data model

## Contract changes

None. No contract exists yet. B1 hand-writes `contract/openapi.yaml`.

## Built

Documents only. No application code, `package.json`, Dockerfile or migration.

- `docs/ARCHITECTURE.md`: context and container views, module map, dependency rules, request flow, event flow, two sale posting sequences including the payment callback, deployment topology, decision index.
- `docs/DOMAIN_MODEL.md`: ubiquitous language, aggregates, invariants (each marked database or domain) and events for every module, the stock and processing lifecycle, the order state machine.
- `docs/DATA_MODEL.md`: conventions, schema index, seven entity relationship diagrams, catalogue of rules the database enforces.
- `docs/data-model/<schema>.md`: 23 table dictionaries covering 231 tables, every column with type, constraints and reason.
- `docs/MODULE_BOUNDARIES.md`: twelve layers, a card per module, the published-key allow-list, the four ports, the lint rule specification and two data checks.
- `docs/security/SECURITY_ARCHITECTURE.md`: eight trust boundaries with a data flow diagram, authentication, authorisation and separation of duties, application controls, encryption and keys, webhook verification, administration.
- `docs/security/THREAT_MODEL.md`: STRIDE for each boundary, four attack trees on the money paths, eighteen abuse cases each with control and detection, a residual risk register.
- `docs/adr/0000-template.md` and ADRs 0001 to 0028.
- `docs/ASSUMPTIONS.md`, `docs/BACKLOG.md`.
- `docs/BUILD_PROMPT.md` amended in its B4 to B12 table: B9 is now B9a and B9b (see Decisions).

## Decisions

The seven the build prompt required:

- Money is integer pesewas, one half-up rounding per line, exact-sum allocation for every split (ADR-0001).
- Stock is one append-only movement row per transfer between two locations, with balances written only by a database trigger (ADR-0002).
- Seeded chart of accounts and an event-to-posting matrix; the ledger posts by subscribing to events inside the caller's transaction (ADR-0003).
- Pricing walks a fixed order of lists, first hit wins, overlaps are impossible by constraint, and no match is a typed "quote required" result (ADR-0004).
- Serializable isolation for stock and ledger writes, with the hot rows (number counter, ledger balances, audit chain head) designed out (ADR-0005).
- Audit events are insert-only, sealed into a hash chain by a separate process, with the chain head signed and stored off the server (ADR-0006).
- Branch for trading and control, location for stock, both from day one (ADR-0007).

Decisions a reader of the shared brief might not expect:

- **The ledger subscribes; nobody calls it (ADR-0003).** The schedule builds the ledger in B8, after inventory, livestock, processing and procurement. Posting by event means those modules are not reopened when it arrives. A boot assertion and nightly reconciliation guard against a missing subscriber.
- **The audit trail is a platform mechanism, not part of the AUD module (ADR-0009).** Identity must write audit rows and audit administration must check permissions; as two modules they would import each other. The audit tables are in the `platform` schema.
- **A counter sale is an order (ADR-0026).** The order module owns the one code path that posts a sale on every channel.
- **Three keys may be referenced from any schema**: `iam.principal`, `mdm.branch`, `mdm.location` (ADR-0011). Every other cross-module reference goes to a published key in a lower layer, or to the document registry.
- **Offline sales always land (ADR-0027).** Where the stock leg would break an invariant, the sale and the money are recorded and the conflict becomes a stock exception. Offline tenders are cash only by default.
- **No table is partitioned in version one** (DATA_MODEL section 1).

Owner's conditions of 2026-11-13, and where each is met:

| Condition | Where |
| --- | --- |
| Order core at the start of B9, planned as B9a and B9b | ADR-0026 (Accepted), `docs/BUILD_PROMPT.md`, `docs/ARCHITECTURE.md` section 11, `docs/MODULE_BOUNDARIES.md` section 2 |
| Unit-days with largest-remainder allocation on integer pesewas | ADR-0028 (Accepted), ADR-0001, `cap.distribution_run` and its sum constraint |
| A test asserting no pesewa is created or lost, three investors, awkward amount | Specified with exact values in ADR-0028 as Test 1. B0 writes no code, so it is a specification: B2 and B12 must implement it under the name given. The figures were recomputed by script in this session |
| Day-count convention and whether the contribution day counts | ADR-0028: actual calendar days in Africa/Accra, period inclusive at both ends, the contribution day counts, the withdrawal day does not |
| Several named levies per category, each with its own base and reclaimable flag, seeded at zero where they do not apply | ADR-0020 (shape Accepted), `mdm.tax_levy`, `mdm.tax_scheme_version`, `mdm.tax_category_levy`, `mdm.tax_levy_base_component` |
| The accountant's answer absorbed without touching billing or the ledger | ADR-0020 "What a change costs": levy rows on billing lines, one control account with the levy as subledger. B8 has a test that adds a fourth levy as data only |

## Assumptions

All are in `docs/ASSUMPTIONS.md`, dated, with who confirms and by when. The ones that most need a person:

- **For the accountant before B8:** the real levy structure and whether produce and live animals are zero-rated or exempt (A-020); VAT registration (A-022); livestock at cost, not fair value (A-024); births at nil cost and breeding stock expensed (A-025); the chart and posting matrix (A-029).
- **For the owner at this gate:** three further schedule assignments (A-040, below).
- **For the owner later:** cash-only tenders offline (A-041); two approvers per branch (A-042); starting values for approval thresholds (A-043).
- **Not verified:** the standard levy rates are as reported on the Ghana Revenue Authority's website on 2026-11-13 and have not been checked against primary sources (A-021). B1 verifies them in `docs/security/COMPLIANCE.md`.
- **To be proved by a test in B2:** the PostgreSQL locking behaviour that ADR-0005 relies on (A-060).

## Deferred

- Everything in `docs/BACKLOG.md`: sixteen items parked by decisions in this session and twelve outside the brief.
- Left to B1 by the documentation table: SRS, `docs/README.md`, data classification, secure coding standards, compliance, API conventions, offline sync rules with worked examples, operations, deployment, runbooks, glossary, UAT, onboarding, skills, `CLAUDE.md`.

## Tests

None. This session produced documents only.

Checks run on the documents, by script:

- All 552 foreign key references in the dictionaries point at a table that exists; every cross-schema reference is to a published or universal key and points from a higher layer to a lower one.
- Every table name and event name mentioned in any document exists in the dictionaries or the domain model. The ledger events in the domain model and the posting matrix in ADR-0003 match exactly.
- All 22 module codes have a card in `docs/MODULE_BOUNDARIES.md` and a dictionary file; all 231 tables appear in an entity relationship diagram; all eight trust boundaries have a STRIDE table; every ADR is in the decision index.
- No placeholder text; every relative link resolves.
- The schema index in `docs/DATA_MODEL.md` was generated from the dictionary headings.

Not verified:

- **The 24 Mermaid diagrams have not been rendered.** Running mermaid-cli was blocked by the session's permission rules. They were checked by a script written in this session for balanced quotes, brackets and blocks, line grammar and declared participants, which found nothing, but that script is not the Mermaid parser. Check them in the pull request, where GitHub renders them.

## Gate

Not yet passed. The gate is the owner reading and approving the architecture and the data model.

Review surface: pull request 1, https://github.com/officialjwise/hakorem_farms_backend/pull/1 (branch `b00-architecture`). Merging it is the approval.

Suggested reading order: `docs/ARCHITECTURE.md`, then ADRs 0001 to 0007, then `docs/DATA_MODEL.md` sections 1 and 4, then the dictionaries for `inv`, `fin` and `ord`.

Three things need a decision at this gate (ADR-0026, proposed part):

1. **Online store.** No backend session in the build prompt names it, yet the slot 8 gate needs checkout to reserve stock. Proposed: catalogue, cart and checkout reservation in B7; order placement and online payment in B9a; abandoned-cart messaging in B11.
2. **Audit administration, second part.** Retention and data-subject requests proposed for B13.
3. **Daily exception report.** Proposed for B12 with reporting.

Also worth knowing before approving:

- The table count is 231, against an estimate of 130 to 160 in the plan.
- `docs/BUILD_PROMPT.md` was edited (B9 rows and one note) in its own commit, `docs(prompt): split B9 into B9a and B9b (ADR-0026)`. Revert that commit if the prompt should stay as issued; the ADR stands either way. `docs/SHARED_BRIEF.md` is unchanged.
- ADR-0009 was revised within the session, before any push, to remove the cycle described above.

## Notes for the frontend track

- Slot 10 is two backend sessions, B9a then B9b. F9 is unchanged and builds against the contract mock. The slot 10 gate is proven after B9b.
- Session cookies are bound to the API host. Storefront pages that need the customer's identity fetch that data in the browser; server-rendered catalogue pages are anonymous (ADR-0016).
- Every state-changing request sends an `Idempotency-Key` and an `X-CSRF-Token`.
- Offline sales carry a client-generated UUIDv7, a per-shift device counter and a provisional reference, and are cash only by default (ADR-0015, ADR-0027).
- Checkout must show the estimated total, the maximum total and the final-charge rule for catch-weight items (ADR-0021).
- A product in `REQUEST_TO_BUY` mode opens a request for quote instead of adding to the cart (ADR-0019).
- A price that does not resolve is a "quote required" result, not an error (ADR-0004).
- Receipts by SMS and WhatsApp for counter sales begin when notifications land in B11. From B9b the counter prints.
- Token lifetimes and cookie attributes in ADR-0016 are design defaults. B3's report carries the exact login flow.

## Next session

B01 — Documents, skills and the contract. Open it with:

"Read docs/SHARED_BRIEF.md and the B1 section of docs/BUILD_PROMPT.md. Read docs/sessions/B00-architecture.md. For the contract, read docs/ARCHITECTURE.md, docs/MODULE_BOUNDARIES.md, docs/DOMAIN_MODEL.md and docs/adr/0026-session-schedule-amendment.md, and read each docs/data-model/<schema>.md only while writing that module's endpoints. Confirm in three lines the phase, its scope and its gate. Execute B01 only: the contract first, then the SRS, then the remaining documents, skills and CLAUDE.md. Stop at the gate and write the session report."

Before B1 starts, the owner's decision on the three proposed schedule assignments should be recorded in ADR-0026, because the SRS traceability matrix names the session that proves each requirement.
