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

Initial focused coverage ran all core tests and the process-supervisor tests
with Node's `--experimental-test-coverage` and included `nodes.js`,
`runtime-session.js`, and `process-supervisor.js`: 181 tests passed, 88.60% line,
88.14% branch, and 80.65% function coverage. Daemon HTTP behavior is covered by
integration tests with controlled backend responses. This does not verify real
Codex/Claude CLIs, uninterruptible kernel processes, or BoxLite guest retirement.

The dependency audit used `npm audit --registry=https://registry.npmjs.org
--audit-level=high` because the configured mirror does not support auditing.
It reported 26 existing advisories (6 low, 4 moderate, 15 high, 1 critical).
Dependencies and lockfiles are unchanged by these fixes.
