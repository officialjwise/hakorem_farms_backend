---
name: hakorem-adr
description: "Use when a decision is made, discovered or about to be contradicted that changes structure, a dependency, a library, a contract convention, a table class, a module boundary or port, an isolation level, a security control, the build schedule or a hard-constraint interpretation; when someone says \"we decided\", \"let's switch to\", \"new library\", \"new port\", \"new table class\" or \"this contradicts ADR\"; when code would disagree with an accepted ADR; or when writing, numbering, accepting, superseding, deprecating or indexing a file under `docs/adr/`, or editing the decision index in section 12 of `docs/ARCHITECTURE.md`. Not for recording an assumption alone (that goes to `docs/ASSUMPTIONS.md`) or parking an idea (`docs/BACKLOG.md`)."
---

# Architecture decision records

House format: `docs/adr/0000-template.md` (read it each time; do not work from memory). Index: section 12 of `docs/ARCHITECTURE.md`. Rule from the brief: decide, then record; a decision that exists only in chat did not happen. If you lack information, choose the option cheapest to reverse, state the assumption in the ADR, and continue.

## When an ADR is required

A new ADR is needed when a change: alters a module boundary, layer or port; adds or replaces a runtime dependency or tool; changes a convention in the contract (envelope, pagination, money shape, auth); adds a table class or role; changes an isolation level or locking approach; changes a security control or key handling; changes the schedule or a gate; or reinterprets one of the hard constraints. A bug fix, a new endpoint that follows the conventions, or a new column inside an existing pattern is not an ADR. If you are unsure, write the short ADR.

## Checklist

1. **Number.** Next free number: list `docs/adr/`, take the highest file number and add one (zero-padded to four digits). Numbers are in order of writing and are never reused or renumbered. File name `NNNN-kebab-case-title.md`, title in the file `# ADR-NNNN: Short title stating the decision` (a decision, not a topic).
2. **Header.** `Status`, `Date` (today, ISO), `Session` (the build session, for example B4), `Deciders` (who decided and who approves).
3. **Sections, in order:** Context (the requirement or constraint from `docs/SHARED_BRIEF.md` or the SRS that applies, and what happens if nothing is decided), Options considered (at least two, each with its main cost; one option is a description, not a decision), Decision (rules a reviewer can check, using concrete names: tables, columns, functions, files), Consequences (what becomes easier, harder and forbidden; name the documents and skills it binds), Verification (the test, constraint or check that proves it, and the session that delivers it; say plainly if a claim is not yet verified and name the test that will verify it).
4. **Status lifecycle.** `Proposed` (written, awaiting the owner) then `Accepted` (owner approved, binding), then possibly `Superseded by ADR-NNNN` or `Deprecated`. Only the owner moves a decision to `Accepted`; record who and when in the status line, for example `Accepted (owner, 2026-11-13)`.
5. **Never edit a decision.** An accepted ADR is not rewritten to change its decision. Write a new ADR that supersedes it and change only the old one's status line to `Superseded by ADR-NNNN`. Before acceptance a Proposed ADR may be revised in place; add a dated "Amended" note saying what changed and why, as ADR-0016 does.
6. **Hard constraints.** A decision that contradicts a hard constraint in the shared brief stays `Proposed` and the build waits for a human answer. Do not code around it.
7. **Link it.** Add a row to the decision index in section 12 of `docs/ARCHITECTURE.md` in the same change: `| [NNNN](adr/NNNN-title.md) | one-line decision |`. Every ADR is linked there; a missing row is a defect. Also update every document the decision binds (`docs/MODULE_BOUNDARIES.md` for ports and boundaries, `docs/DATA_MODEL.md` and `docs/data-model/<schema>.md` for tables, `docs/security/SECURITY_ARCHITECTURE.md`, `docs/API.md`, the relevant skill) in the same change.
8. **Assumptions and parked work.** Anything assumed in place of an answer goes to `docs/ASSUMPTIONS.md` (dated, with who confirms and by when). Anything deliberately left out goes to `docs/BACKLOG.md`.
9. **Cite by number and path** in code comments and documents: `ADR-0005`, `docs/adr/0005-aggregate-boundaries-and-isolation.md`. Never describe a decision without pointing to its ADR.
10. **Say so in the session report** (decisions section) and in the commit message (`docs(adr): ...`).

## Correct and incorrect

The examples are illustrative: the number you use is whatever is next free when you write (step 1), not 0030.

```markdown
# ADR-0030: Reports above 10,000 rows are produced by the worker as files

- **Status:** Proposed
- **Date:** 2026-11-14
- **Session:** B12
- **Deciders:** backend track; owner approves

## Context
The shared brief requires export of every report and a counter that is never slowed by a heavy report ...

## Options considered
1. **Stream the export from the API.** Simple, but holds a connection and an API process for minutes.
2. **Produce a file in the worker and deliver a signed link.** One more state to show the user.

## Decision
Option 2. `rpt.report_run` gains `status` and `file_id` ...

## Consequences
...binds `docs/data-model/rpt.md` and the B12 session.

## Verification
B12: a 200,000-row export completes without exceeding the API p95 latency target ...
```

Index row added in the same change:

```markdown
| [0030](adr/0030-report-files-from-the-worker.md) | Large reports are produced by the worker as files |
```

```markdown
<!-- WRONG -->
# ADR 30 - Reports
Status: decided            <- not a lifecycle value, no date, no session
We will use the worker.    <- no context, one option, no verification, not indexed
```

```diff
- ADR-0004 Decision: option 3, first hit wins
+ ADR-0004 Decision: option 2, tie-break by date     <- WRONG: edited an accepted decision
```

The right move for the last case is `docs/adr/0030-...md` with `Supersedes ADR-0004` in its context, and ADR-0004's status line changed to `Superseded by ADR-0030`.
