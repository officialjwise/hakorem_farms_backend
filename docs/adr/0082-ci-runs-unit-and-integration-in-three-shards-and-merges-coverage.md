# ADR-0082: CI runs the unit and integration suites in three shards and judges coverage once, merged

- **Status:** Proposed (2026-11-23)
- **Date:** 2026-11-23
- **Session:** B09b continued 3c
- **Deciders:** backend track; the parent session gave leave on 2026-11-23 (the owner decides NFR-016 itself)

## Context

NFR-016 puts the whole pipeline under 12 minutes. TEST_STRATEGY section 3 says the integration suite runs under 6 minutes on CI and that suites are parallelised. The job "unit and integration with the coverage gate (NFR-015)" ran both suites in one process on one runner, under `timeout-minutes: 12`, the NFR's own figure. By B09b continued 3c that step took 568 to 574 s of the 720 s.

On PR #120 a head that differed from a green head only by a Markdown file was cancelled at 12 minutes in both its runs (45104107067 push, 45104112126 pull_request). 106 of 161 integration files had passed, with no failure. The timeout is the NFR, so raising it would break the requirement; the parent session refused that.

## Options considered

1. **Raise `timeout-minutes`.** It breaks NFR-016, which is the owner's to change.
2. **Make the suite faster file by file.** Worth doing, but it never ends, and the next phase's specs bring the same problem back.
3. **Shard across parallel runners and merge the coverage.** Vitest's `--shard` splits the files, and its blob reporter carries each shard's results and coverage. `--merge-reports --coverage` rebuilds the whole run's report and judges the thresholds once.

## Decision

Option 3.

- `test-shard`, a matrix of shards 1 to 3 with `fail-fast: false`. Each runs `pnpm test:coverage:shard --shard=<n>/3`, which is `HK_COVERAGE_SHARD=1 vitest run --project unit --project integration --coverage --reporter=blob --reporter=default`. Each keeps `timeout-minutes: 12`, and each uploads its `.vitest-reports/` as `vitest-blob-<n>`.
  - With `HK_COVERAGE_SHARD=1` the config judges no threshold, because a shard's coverage alone is partial.
  - Nothing else in the config changes: the include, the exclude and every threshold stay as written.
- `test` keeps its name, "unit and integration with the coverage gate (NFR-015)". It `needs: test-shard` and runs `if: always()`, so it reports rather than skips.
  1. It fails unless every shard succeeded ("every shard passed").
  2. It fails unless all three blob reports arrived ("none missing").
  3. It runs `pnpm test:coverage:merge` (`vitest --merge-reports --coverage`). That judges today's global and per-file thresholds, every 100 percent gate included, once over the merged run, and fails as the single job did.
- Every test still runs exactly once: `--shard` splits by file, with no overlap and no gap. The merged summary's counts are the local full run's (checked in the report).
- Locally nothing changes: `pnpm test:coverage` still runs everything at once.

## Consequences

- The slowest shard bounds the job's time, about a third of the old step plus its own setup, so the pipeline stays under NFR-016 with room to grow. When one shard nears 12 minutes, the matrix grows.
- Three more runners per run, and two artifact actions, pinned by commit SHA like every other action.
- Integration files must stay independent of each other's order. They already are: each makes its own database from the template.

## Verification

- Locally, two unit shards merged give exactly the counts and the threshold verdicts of one unsharded run (152 files, 1,817 tests, the same errors when run alone).
- On PR #120:
  - a deliberate red, with shard 2 made to fail, failed the gate job;
  - its revert passed with every shard green and the merged counts equal to the local full run.

  The run ids are in the B09b continued 3c report.
