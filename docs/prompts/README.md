# Build prompts

The prompts that build the HaKorem Farms Platform, and how they fit together. The system is built by Claude Code sessions, one phase each, and every session is steered by documents. Nothing is built from memory of an earlier conversation.

## The prompt documents

| File | What it is for | Who reads it | When |
| --- | --- | --- | --- |
| [`../SHARED_BRIEF.md`](../SHARED_BRIEF.md) | The shared brief, binding on both tracks: business, domain, requirements, security, integrity rules, the session protocol, the definition of done and the seven acceptance scenarios. **Not copied here**; this is the original | Every session, first | Start of every session |
| [`../BUILD_PROMPT.md`](../BUILD_PROMPT.md) | The backend build prompt: how to run, one section per session (B0, B1, B2, B3, "B4 to B12", B13), the recipe for module sessions, the commands, the commit rules and the session report format. **Not copied here** | Every backend session, its own section only | Start of every session |
| [`session-openers.md`](session-openers.md) | The exact opening message for each remaining backend session, B2 to B13, with the report name, branch and gate for each | The person starting a session | Pasted as the first message |
| [`module-build-prompt.md`](module-build-prompt.md) | The reusable prompt for the module sessions B4 to B12: the recipe as a fill-in prompt, a table of the values to fill in, and the definition of done as a checklist | Sessions B4 to B12 | After the opener, as the recipe |
| [`SKILLS_VERIFICATION.md`](SKILLS_VERIFICATION.md) | The record that each of the sixteen Claude Code skills fires on the kind of task it is meant for | Whoever changes a skill | After a skill's description changes |

The frontend repository has its own `docs/BUILD_PROMPT.md` and its own openers. They are not in this folder, and nothing in this repository refers to the frontend's code.

## How the pieces fit together

```text
SHARED_BRIEF.md ──────────────┐  what must be true of the whole system
BUILD_PROMPT.md  ─────────────┤  what each session builds, and the gate that ends it
session-openers.md  ──────────┤  the message that starts a session and tells it what to read
module-build-prompt.md  ──────┘  how a module session builds (B4 to B12)
        │
        ▼
a session  ──►  docs/sessions/<ID>-<slug>.md  ──►  its "Next session" message
                                                    (which is the next opener)
```

- The **brief** says what is required. The **build prompt** says which session builds what. The **openers** make each session start the same way. The **module prompt** makes B4 to B12 build the same way.
- The **session report** is the only thing a session leaves for the next. Its "Next session" section holds the exact opening message for the next session. When that differs from the opener in `session-openers.md`, the report is right (it knows what actually happened) and `session-openers.md` is corrected afterwards.

## The session protocol in one screen

1. Open at the workspace root (`~/Desktop/hakorem-farms/`).
2. Paste the opener. It makes the session read `CLAUDE.md`, the shared brief and only its section of the build prompt, then only the latest report in `docs/sessions/`; from B4 onward, the frontend's `CONTRACT_REQUESTS.md` too.
3. The session confirms in three lines the phase, its scope and its gate, then executes that phase only.
4. It stops at the gate and writes `docs/sessions/<ID>-<slug>.md` (ids `B02`, `B03`, ..., `B09a`, `B09b`, `B10`, ..., `B13`).
5. It commits and pushes to a branch named for the session (`b05-inventory-ledger`, `b09a-order-core-payments`, `b09b-pos-shifts-offline`), opens a pull request, and the pull request is merged when CI is green.

A session starts fresh when the phase is finished, when context passes roughly sixty percent, when it re-reads a file it already read, or when it starts summarising instead of building.

## Keeping the prompts true

- A prompt that contradicts a document is a bug in the prompt. Fix it in the same pull request as the document change.
- The schedule lives in `docs/adr/0026-session-schedule-amendment.md`. A change to the plan updates that ADR (or adds one), then `docs/BUILD_PROMPT.md` if its table moves, then `session-openers.md` and the fill-in table in `module-build-prompt.md`.
- A new skill, or a changed skill description, is verified by describing a task that should fire it in a fresh session; the result goes in `SKILLS_VERIFICATION.md`.
- Never leave a gap in a prompt that a session would have to guess at. The fill-in fields in `module-build-prompt.md` each have a row of values in its section 1.

See also: [`../ONBOARDING.md`](../ONBOARDING.md) for setup and the reading order, [`../UAT.md`](../UAT.md) for the acceptance scripts the later sessions dry-run, and [`../GLOSSARY.md`](../GLOSSARY.md) for the names.
