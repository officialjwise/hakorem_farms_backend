# Module build prompt

The reusable prompt for backend sessions B4 to B12 (including B9a and B9b). It restates "The recipe every module session follows" in `docs/BUILD_PROMPT.md` as a prompt with the module filled in, and carries the definition of done from `docs/SHARED_BRIEF.md` as a checklist.

The opening message for each session is in `docs/prompts/session-openers.md`. That message tells the session what to read; this prompt tells it how to build. Paste this prompt after the opener, or let the opener's line "Use docs/prompts/module-build-prompt.md as the recipe" send the session here.

If this file and `docs/BUILD_PROMPT.md` ever disagree, the build prompt wins and this file is corrected.

## 1. How to fill it in

Replace each field in section 2 with the values from the row for your session. Nothing else in the prompt changes. The values come from the amended schedule in `docs/adr/0026-session-schedule-amendment.md`.

| Session | Modules (SRS block prefixes) | Schemas | ADRs to read | Gate |
| --- | --- | --- | --- | --- |
| B4 | MDM: catalogue, pricing, promotions, tax configuration | `mdm` | 0001, 0004, 0020, 0021 | A price resolves for every band, channel and customer tier; an unresolvable request becomes a quote, not an error |
| B5 | INV | `inv` | 0002, 0005, 0018, 0019, 0027 (stock exception) | On-hand from movements matches a hand count; stock cannot go negative outside the allowed movement types; a lot traces in both directions |
| B6 | LIV, PRC | `liv`, `prc` | 0018, 0019, 0002 | A processing order consumes an animal and produces lots whose costs sum exactly to input cost plus direct processing cost |
| B7 | PUR; and, proposed, SHP (catalogue, cart, checkout reservation) | `pur`, `shp` | 0019, 0020, 0026 | Three-way match blocks payment on disagreement; checkout reserves stock and releases it on timeout |
| B8 | FIN, BIL, DOC | `fin`, `bil`, `doc` | 0001, 0003, 0005, 0015, 0020 | Trial balance sums to zero on a seeded day; an unbalanced journal is rejected by the database; numbering is gap-free under concurrent load |
| B9a | ORD (core), PAY; and, proposed, online order placement | `ord`, `pay` | 0010, 0014, 0021, 0026, 0003 | Every payment edge case in the brief passes; an order on any channel posts stock, document, payment and ledger in one transaction |
| B9b | POS, offline sync | `pos` (and the offline columns in `ord`, `inv`) | 0015, 0027 | Shift close reconciles; 500 queued offline transactions sync exactly once |
| B10 | QUO, WHL | `quo`, `whl` | 0004, 0017, 0019 | Quote revisions are versioned; conversion to invoice preserves every link; a credit limit blocks with an audited override |
| B11 | ORD (fulfilment), DEL, NTF; and, proposed, abandoned-cart messaging | `ord`, `del`, `ntf`, `shp` | 0010, 0021, 0026 | A catch-weight order re-prices at pick; cash on delivery lands against the driver; the outbox guarantees the customer notification |
| B12 | CAP, CST, RPT, API; and, proposed, the daily exception report | `cap`, `cst`, `rpt`, `api` | 0018, 0023, 0028, 0026 | A distribution matches a hand calculation on unit-days and ties exactly to the ledger |

Note for B9a: the recipe applies unchanged. B9a builds the order core and payments only; point of sale, shifts and offline sync are B9b. Note for B13: it is not a module session and has its own section in `docs/BUILD_PROMPT.md`.

## 2. The prompt

Copy from here to the end of the fenced block, with the fields filled in.

```text
You are running backend session <SESSION ID>, building <MODULES> for the HaKorem Farms Platform.
You work inside backend/ on branch <BRANCH> and nowhere else. Never write under ../frontend, never
open its source, and never run git commands that touch it.

SCOPE:    <MODULES>, schemas <SCHEMAS>.
GATE:     <GATE>.
READ:     the <MODULE PREFIXES> requirement block(s) of docs/SRS.md and nothing else from the SRS;
          docs/data-model/<SCHEMA>.md for each schema you own; your module card(s) in
          docs/MODULE_BOUNDARIES.md; docs/DOMAIN_MODEL.md section 5 for your module(s); ADRs <ADRS>.
          Read the contract narrowly: grep contract/openapi.yaml for the operations tagged with your
          module. It is 3 MB; never read it whole.

THE RECIPE. Do these in order and do not reorder them.

1. Read your module's requirement block in the SRS, and nothing else from the SRS.
2. Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists. Decide what to honour. Record in the
   session report what you implemented and what you declined, with the reason for each. Never edit
   that file.
3. Write the failing tests first for every rule involving money, stock, weight or permission. Each
   asserts an exact value (an integer pesewa, an exact weight to three places, a named role refused).
   Write the rounding and boundary cases as their own named tests.
4. Build in layers: domain, then application, then infrastructure, then interface. Never the reverse.
   The domain layer imports nothing from the framework or the database.
5. Wire audit, authorisation and the outbox. A module without all three is not finished: every
   state change writes its audit event with before and after values; every handler checks its
   permission in the domain layer, deny by default, with a test that the wrong role is refused;
   every event that others react to is written to the outbox in the same transaction as the change.
6. Regenerate the OpenAPI specification and diff it against contract/openapi.yaml. Anything that
   moved is versioned: bump the version, add an entry to docs/CONTRACT_CHANGELOG.md, and name the
   change at the top of the session report. A breaking change needs a major version.
7. Write your module's section of docs/API.md and any ADR this session produced (one decision, one
   file, linked from the decision index in docs/ARCHITECTURE.md section 12).
8. Run all four test layers (unit, integration, contract, end to end; smoke if you changed a
   critical flow), plus lint, type check and the security scan. Commit, push, open the pull
   request, and write the session report.

THREE RULES THAT CATCH THE FAILURES THAT ACTUALLY HAPPEN.

- No business rule in a controller. If a test has to call an HTTP endpoint to exercise a calculation,
  the calculation is in the wrong layer.
- No reaching across modules. Take another module's data through its published interface or a
  domain event, never a direct query and never a join across module tables. Import only from a lower
  layer, through its index.ts. If you need a fact from a higher layer, publish an event.
- Each session extends the seed script, so later sessions inherit a realistic farm with stock,
  history and customers rather than an empty database. Seed data comes from a factory, is clearly
  marked as seed, uses Ghanaian names, products, prices and weights, and is never production data.

THREE MORE THAT GO WRONG IN THIS CODEBASE.

- Money is integer pesewas in a field ending _pesewas, rounded half-up once at the line, split only
  with allocate. Never a float, never a second rounding.
- Stock and the ledger are append-only. Never update or delete a movement, a journal entry, an
  audit event or a payment allocation; correct with a reversing row that references the original.
- A rule the brief says the database enforces is a constraint or a trigger, not only code. Add the
  migration (expand then contract) and the test that the database refuses the bad row.

WHEN YOU ARE UNSURE.

- If the work contradicts a document, stop and say so; do not code around it.
- If you lack information, pick the option cheapest to reverse, write the assumption in
  docs/ASSUMPTIONS.md with who must confirm it, and continue. Ask at most three questions, once,
  at the start of the phase.
- New ideas go to docs/BACKLOG.md, not into this session.
- If the modules prove too large for one context, split at a module boundary, stop at the nearest
  green commit, and label the next session "<SESSION ID> continued". Never split in the middle of a
  module.

DONE means every item of the checklist in docs/prompts/module-build-prompt.md section 3 is true.
Stop at the gate. Do not begin the next phase however much context is left.

Finish by writing docs/sessions/<SESSION ID>-<slug>.md with: contract changes first; what was built;
decisions; assumptions; deferred; tests (counts and coverage); the gate result; notes for the
frontend track; and the exact opening message for the next session.
```

## 3. Definition of done

A piece of work is done when all of the following are true, not when the feature appears to work. This list is the definition of done in `docs/SHARED_BRIEF.md`, unchanged in meaning. The session's last step is to tick each item against the pull request and say, in the report, which item is not yet true and why.

- [ ] The functional requirement it implements is referenced by id in the commit or pull request (`feat(inventory): post stock take variance (FR-INV-031)`).
- [ ] Every test layer that applies passes: unit, integration against a real PostgreSQL, contract, end to end, and the smoke path if it is a critical flow.
- [ ] Authorisation is checked at the domain layer, and a test proves the wrong role is refused.
- [ ] The error paths are implemented, not just the happy path, and failure responses carry a correlation id.
- [ ] Any money, stock or weight calculation has a test asserting an exact value, including a rounding edge case.
- [ ] The audit trail records the action with actor, timestamp and before and after values.
- [ ] The OpenAPI contract is regenerated and matches the committed file, or the change is versioned and logged in `docs/CONTRACT_CHANGELOG.md`.
- [ ] Documentation is updated in the same change: the API specification, the relevant `docs/` file, and an ADR if a decision was made.
- [ ] The import boundary rule, lint, type check, full test suite and security scan all pass in CI.
- [ ] No `TODO`, no commented-out code, no skipped test, no hard-coded secret, no magic number without a named constant.
- [ ] The work is committed and pushed to its own repository (`git remote -v` shows `hakorem_farms_backend`), and the session report names it.

Module-specific additions that follow from the recipe:

- [ ] The tests for money, stock, weight and permission rules were written before the code they cover, and 100 percent branch coverage holds on pricing, ledger, stock valuation and distribution code where the module touches them.
- [ ] Every rule marked `DB` in `docs/DOMAIN_MODEL.md` for this module has a migration and a test that the database refuses the violation.
- [ ] The module's published interface (`index.ts`), its events and its ports are the only way another module uses it, and the boundary lint passes.
- [ ] Each state-changing endpoint requires an `Idempotency-Key`, and a replay returns the first result.
- [ ] The seed script is extended with this module's data and runs against a clean database.
- [ ] Every abuse case in `docs/security/THREAT_MODEL.md` section 4 that this module's controls cover has a test for its control, and the module publishes whatever the daily exception report needs to detect it.
- [ ] The frontend's requests in `../frontend/docs/CONTRACT_REQUESTS.md` are each implemented or declined with a reason, in the report.
- [ ] The gate was proven by running it, not by reasoning about it, and the report says how.

## 4. A worked example of a filled-in prompt

For B5 the fields read:

- `<SESSION ID>`: `B05`
- `<MODULES>`: Inventory (INV)
- `<BRANCH>`: `b05-inventory-ledger`
- `<SCHEMAS>`: `inv`
- `<GATE>`: On-hand derived from movements matches a hand count, stock cannot go negative outside the allowed movement types, and a lot traces in both directions
- `<MODULE PREFIXES>`: INV
- `<ADRS>`: 0002, 0005, 0018, 0019, 0027 (stock exception)
- `<slug>`: `inventory-ledger`, so the report is `docs/sessions/B05-inventory-ledger.md`

The first failing tests in that session are the ones ADR-0002 names: a movement that would make on-hand negative at a physical location is refused; a serial unit cannot be sold twice; a sale under a hold is refused; an update or delete of a movement is refused; and a balance that does not equal the sum of movements is detected by the nightly check.
