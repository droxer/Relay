# Retry and recovery review fixes

Journeys were derived from the three review findings in this thread.

| Guarantee | Regression test | Evidence |
| --- | --- | --- |
| Claude and Codex keep startup conversation IDs after transcript truncation; an actual failed resumed run does not run again afresh | `packages/relay-core/tests/agent-resume.test.ts`: transcript truncation cases | Four cases failed before the fix, then passed |
| A foreground process that never closes is reported as unconfirmed, remains reserved until an operator releases it, and can then return without `close` | `packages/relay-daemon/tests/process-supervisor.test.ts`: foreground process case | Failed with zero reports before the fix, then passed |
| A healthy registration route cannot end grace while execution endpoints are unavailable | `packages/relay-daemon/tests/daemon.test.ts`: healthy registration and registration fallback heartbeat cases | Both failed before their fixes, then passed |

RED compilation: `npx tsc -p packages/tsconfig.json` passed. Running the
`transcript truncation|foreground process|healthy registration` test-name
pattern across the three built test files executed six tests, all failing for
the intended bugs. RED checkpoint: `ff56590f`. The additional
`registration fallback heartbeat` case also failed before changing which
responses clear the outage state.

GREEN: the same six cases plus the registration fallback case passed (7/7).
The complete resume and process-supervisor test files then passed (14/14),
including malformed/oversized metadata and an unterminated final event.

Implementation:

- Parse runtime session metadata from live, chunked JSONL independently of the
  adapter's transcript tail. Metadata buffering is bounded to 1 MiB per line;
  oversized records are discarded until the next newline. Adapters that only
  return stdout retain the existing final-transcript fallback.
- Start the exit report timer when cancellation is requested, retain it during
  descendant cleanup, and observe operator release independently of `close`.
  Release clears timers/listeners and detaches the child's handles while
  retaining the explicit unverified-exit result. A timeout alone never releases.
- Retry poll 5xx/408/429 as transient failures. Only execution poll/heartbeat
  ownership responses or credential rejection clear the execution outage state;
  successful registration, including heartbeat fallback, does not.

Final focused coverage ran all core tests and the process-supervisor tests
with Node's `--experimental-test-coverage` and included `nodes.js`,
`runtime-session.js`, and `process-supervisor.js`: 183 tests passed, 89.74% line,
89.60% branch, and 80.65% function coverage. Daemon HTTP behavior is covered by
integration tests with controlled backend responses. This does not verify real
Codex/Claude CLIs, uninterruptible kernel processes, or BoxLite guest retirement.

The dependency audit used `npm audit --registry=https://registry.npmjs.org
--audit-level=high` because the configured mirror does not support auditing.
It reported 26 existing advisories (6 low, 4 moderate, 15 high, 1 critical).
Dependencies and lockfiles are unchanged by these fixes.

## Repository verification

- GREEN implementation checkpoint: `a0683be8`.
- `npx tsc -p packages/tsconfig.json`: passed.
- Compiled repository suites (`node --test` over core, chat, daemon, supervisor,
  and web tests): **2,048 passed**, no failures or skips.
- `PATH=/Users/feihe/.nvm/versions/node/v22.20.0/bin:$PATH npm run test:react
  -w web -- --maxWorkers=2`: **431 passed** across 67 files. Default worker
  startup under Node 26 was slow; interrupted runs are not counted as passes.
- From `web/`, `npx playwright test -c playwright.recovery.config.ts
  executionRecovery.spec.ts agentResume.spec.ts --workers=2`: **16 passed**.
- `npm run build -w web -- --webpack`: passed, including TypeScript and static
  page generation. The normal `npm test` chain stopped in Turbopack because its
  CSS worker could not bind a port (`EPERM`), even on a retried build; the
  individual suites above were run separately. The restricted TypeScript run
  had three process/port fixture failures and one skip; the unrestricted run
  passed all 2,048 tests. Restricted backend installer fixtures likewise could
  not access `/dev/tty`; the unrestricted rerun passed those fixtures.
- `git diff --check`: passed.
- The full unrestricted `npm run test:py` rerun did not complete before PR
  preparation. Completed API tests had no failures. After merging current main,
  the affected backend suite passed **348 tests**: execution escape, lifecycle,
  reconciliation API, and daemon registry. No complete backend-suite pass is
  claimed for the final merged head.

## Current-main integration

Merged current main locally before publishing the PR. Resolved four conflicts
in the execution lifecycle, recovery guidance tests, API documentation, and agent
guide. Kept main's earliest stop/deletion intent and late-result preservation
alongside the offline/restarted/unconfirmed-exit recovery markers. Extended the
execution escape sweep with both new durable execution markers and a long-expired
lease, preserving the invariant that overdue deletion always has a way out.

Post-merge verification: the affected backend suite passed 348 tests; React
passed all 431 tests; the production webpack build and TypeScript checks passed;
all 16 recovery/resume browser tests passed. Updated the two browser route
assertions for main's new `/computers` destination. The first compiled-suite
run used stale packaged installer output and failed its new upgrade assertion;
rebuilt daemon/supervisor packages and the computer bundle before rerunning.
The final post-merge compiled suite passed all **2,062 tests**, with no failures
or skips. `git diff --check` passed.
