# ADR-NNNN: Short title stating the decision

- **Status:** Proposed | Accepted | Superseded by ADR-NNNN | Deprecated
- **Date:** YYYY-MM-DD
- **Session:** the build session that made the decision, for example B0
- **Deciders:** who made it and who approved it

## Context

What forces the decision. Quote the requirement or constraint from `docs/SHARED_BRIEF.md` or the SRS that applies. State what happens if nothing is decided.

## Options considered

1. **Option name.** What it is, in one or two sentences, and its main cost.
2. **Option name.** As above.

List at least two. An ADR with one option is a description, not a decision.

## Decision

The option chosen, stated as rules a reviewer can check. Use concrete names: tables, columns, functions, files.

## Consequences

What becomes easier, what becomes harder, and what is now forbidden. Name the documents and modules this binds.

## Verification

The test, constraint or check that proves the decision holds, and the session that must deliver it. If a claim about a tool or database is not yet verified, say so here and name the test that will verify it.

---

## House rules

- One decision per file. File name is `NNNN-kebab-case-title.md`, numbered in order of writing, never renumbered.
- An ADR is never edited to change its decision. A new ADR supersedes it, and the old one gets `Superseded by ADR-NNNN` in its status line.
- Status lifecycle: `Proposed` (written, awaiting the owner) then `Accepted` (owner approved, binding) then possibly `Superseded` or `Deprecated`.
- A decision that contradicts a hard constraint in the shared brief stays `Proposed` and the build waits for a human answer.
- Every ADR is linked from `docs/ARCHITECTURE.md` in the decision index.
